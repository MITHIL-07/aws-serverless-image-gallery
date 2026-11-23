"""
Serverless Image Gallery API
----------------------------
One Lambda function behind an API Gateway HTTP API (payload format 2.0).

Routes:
    POST /upload-url   Validate the request and return a pre-signed POST, so the
                       browser can upload the image straight to the private S3 bucket.
    POST /confirm      Check that the file really exists in S3, then mark it as uploaded.
    GET  /images       List uploaded images. Images are served through CloudFront, or through
                       short-lived pre-signed links if CloudFront is not available yet.
    POST /delete       Delete an image. Needs the secret delete token that was given to the
                       uploader's browser when the image was uploaded.

Environment variables (set in the Lambda console):
    BUCKET_NAME         Private S3 bucket that stores the images
    TABLE_NAME          DynamoDB table name, e.g. GalleryImages
    CLOUDFRONT_DOMAIN   Optional. CloudFront domain, e.g. d1234abcd.cloudfront.net (no https://).
                        If it is empty, images are served with pre-signed GET links instead.
    MAX_FILE_SIZE_MB    Optional. Maximum image size in MB (default 5)

CORS is configured on the API Gateway itself, so this function does not return CORS headers.
"""

import base64
import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import time
import uuid
from datetime import datetime, timezone

import boto3
from boto3.dynamodb.conditions import Attr
from botocore.config import Config
from botocore.exceptions import ClientError

logger = logging.getLogger()
logger.setLevel(logging.INFO)

BUCKET_NAME = os.environ.get("BUCKET_NAME", "")
TABLE_NAME = os.environ.get("TABLE_NAME", "")
CLOUDFRONT_DOMAIN = (
    os.environ.get("CLOUDFRONT_DOMAIN", "")
    .replace("https://", "")
    .replace("http://", "")
    .strip("/")
)
MAX_FILE_SIZE_MB = int(os.environ.get("MAX_FILE_SIZE_MB", "5"))
MAX_FILE_SIZE = MAX_FILE_SIZE_MB * 1024 * 1024
REGION = os.environ.get("AWS_REGION", "ap-south-1")

UPLOAD_URL_EXPIRES_SECONDS = 300   # the pre-signed upload is valid for 5 minutes
IMAGE_URL_EXPIRES_SECONDS = 3600   # fallback image links (no CloudFront) are valid for 1 hour
PENDING_TTL_SECONDS = 3600         # unfinished uploads are cleaned up by DynamoDB TTL (optional)
MAX_LIST_ITEMS = 100

# Allowed image types and the file extension used for each
ALLOWED_TYPES = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
}

UUID_PATTERN = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)

# SigV4 + virtual-hosted style gives a regional URL like
# https://<bucket>.s3.ap-south-1.amazonaws.com/
s3 = boto3.client(
    "s3",
    region_name=REGION,
    config=Config(signature_version="s3v4", s3={"addressing_style": "virtual"}),
)
dynamodb = boto3.resource("dynamodb")


def _table():
    return dynamodb.Table(TABLE_NAME)


def _response(status_code, body):
    return {
        "statusCode": status_code,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body),
    }


def _clean(value, max_len):
    if not isinstance(value, str):
        return ""
    return value.strip()[:max_len]


def _parse_body(event):
    body = event.get("body") or ""
    if event.get("isBase64Encoded"):
        body = base64.b64decode(body).decode("utf-8")
    data = json.loads(body)
    if not isinstance(data, dict):
        raise ValueError("Body must be a JSON object")
    return data


def _now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _hash_token(token):
    """Only the hash of a delete token is stored, never the token itself."""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _image_url(key):
    """CloudFront URL if configured, otherwise a temporary pre-signed link to the private object."""
    if CLOUDFRONT_DOMAIN:
        return f"https://{CLOUDFRONT_DOMAIN}/{key}"
    return s3.generate_presigned_url(
        "get_object",
        Params={"Bucket": BUCKET_NAME, "Key": key},
        ExpiresIn=IMAGE_URL_EXPIRES_SECONDS,
    )


def _public_image(item):
    """Convert a DynamoDB item into the JSON the website needs."""
    return {
        "id": item["id"],
        "title": item.get("title", ""),
        "url": _image_url(item["key"]),
        "contentType": item.get("contentType", ""),
        "size": int(item.get("size", 0)),
        "createdAt": item.get("uploadedAt") or item.get("createdAt", ""),
    }


# ---------------------------------------------------------------------------
# POST /upload-url
# ---------------------------------------------------------------------------
def create_upload_url(event):
    data = _parse_body(event)

    content_type = _clean(data.get("contentType"), 50).lower()
    if content_type not in ALLOWED_TYPES:
        return _response(400, {"message": "Only JPG, PNG, WEBP and GIF images are allowed."})

    size = data.get("size")
    if isinstance(size, bool) or not isinstance(size, int) or size < 1 or size > MAX_FILE_SIZE:
        return _response(400, {"message": f"Image must be smaller than {MAX_FILE_SIZE_MB} MB."})

    title = _clean(data.get("title"), 80)

    # Secret that lets the uploader (and only the uploader) delete this image later.
    # It is returned once, to this browser. DynamoDB keeps only its hash.
    delete_token = secrets.token_urlsafe(32)

    image_id = str(uuid.uuid4())
    key = f"uploads/{image_id}.{ALLOWED_TYPES[content_type]}"

    # The pre-signed POST lets the browser upload ONE file to ONE key, and S3 itself
    # enforces the content type and the size range, even if someone bypasses the website.
    upload = s3.generate_presigned_post(
        Bucket=BUCKET_NAME,
        Key=key,
        Fields={"Content-Type": content_type},
        Conditions=[
            {"Content-Type": content_type},
            ["content-length-range", 1, MAX_FILE_SIZE],
        ],
        ExpiresIn=UPLOAD_URL_EXPIRES_SECONDS,
    )

    _table().put_item(
        Item={
            "id": image_id,
            "key": key,
            "title": title,
            "contentType": content_type,
            "status": "pending",
            "deleteTokenHash": _hash_token(delete_token),
            "createdAt": _now_iso(),
            "expiresAt": int(time.time()) + PENDING_TTL_SECONDS,
        }
    )
    logger.info("Created upload permission for image %s", image_id)

    return _response(
        200,
        {
            "id": image_id,
            "upload": upload,
            "deleteToken": delete_token,
            "maxSizeBytes": MAX_FILE_SIZE,
        },
    )


# ---------------------------------------------------------------------------
# POST /confirm
# ---------------------------------------------------------------------------
def confirm_upload(event):
    data = _parse_body(event)

    image_id = _clean(data.get("id"), 64).lower()
    if not UUID_PATTERN.match(image_id):
        return _response(400, {"message": "Invalid image id."})

    item = _table().get_item(Key={"id": image_id}).get("Item")
    if not item:
        return _response(404, {"message": "Image not found."})

    # Already confirmed: return it again (safe to call twice)
    if item.get("status") == "uploaded":
        return _response(200, {"image": _public_image(item)})

    # Make sure the file really arrived in S3
    try:
        head = s3.head_object(Bucket=BUCKET_NAME, Key=item["key"])
    except ClientError:
        logger.info("Confirm failed: object %s not found in S3", item["key"])
        return _response(400, {"message": "Upload not found. Please try uploading again."})

    updated = _table().update_item(
        Key={"id": image_id},
        UpdateExpression="SET #s = :uploaded, uploadedAt = :ts, #sz = :size REMOVE expiresAt",
        ConditionExpression="attribute_exists(id)",
        ExpressionAttributeNames={"#s": "status", "#sz": "size"},
        ExpressionAttributeValues={
            ":uploaded": "uploaded",
            ":ts": _now_iso(),
            ":size": head["ContentLength"],
        },
        ReturnValues="ALL_NEW",
    )["Attributes"]
    logger.info("Confirmed image %s", image_id)

    return _response(200, {"image": _public_image(updated)})


# ---------------------------------------------------------------------------
# POST /delete
# ---------------------------------------------------------------------------
def delete_image(event):
    data = _parse_body(event)

    image_id = _clean(data.get("id"), 64).lower()
    token = _clean(data.get("deleteToken"), 128)
    if not UUID_PATTERN.match(image_id) or not token:
        return _response(400, {"message": "Invalid delete request."})

    item = _table().get_item(Key={"id": image_id}).get("Item")
    if not item:
        return _response(404, {"message": "Image not found."})

    # Compare hashes in constant time. Images uploaded before this feature have no
    # stored hash, so they cannot be deleted from the website (use the AWS console).
    stored_hash = item.get("deleteTokenHash", "")
    if not stored_hash or not hmac.compare_digest(stored_hash, _hash_token(token)):
        logger.info("Delete refused for image %s: missing or wrong token", image_id)
        return _response(
            403, {"message": "You can only delete images you uploaded from this browser."}
        )

    # Delete the file first. If the next step fails, calling delete again is safe.
    s3.delete_object(Bucket=BUCKET_NAME, Key=item["key"])
    _table().delete_item(Key={"id": image_id})
    logger.info("Deleted image %s", image_id)

    return _response(200, {"message": "Image deleted.", "id": image_id})


# ---------------------------------------------------------------------------
# GET /images
# ---------------------------------------------------------------------------
def list_images():
    table = _table()
    items = []
    scan_kwargs = {"FilterExpression": Attr("status").eq("uploaded")}

    while True:
        page = table.scan(**scan_kwargs)
        items.extend(page.get("Items", []))
        if "LastEvaluatedKey" not in page or len(items) >= 500:
            break
        scan_kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]

    # Newest first
    items.sort(key=lambda i: i.get("uploadedAt") or i.get("createdAt", ""), reverse=True)
    images = [_public_image(i) for i in items[:MAX_LIST_ITEMS]]

    logger.info("Returning %d images", len(images))
    return _response(200, {"images": images})


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
def lambda_handler(event, context):
    if not (BUCKET_NAME and TABLE_NAME):
        logger.error("Missing environment variables: BUCKET_NAME, TABLE_NAME")
        return _response(500, {"message": "Server configuration error."})

    route = event.get("routeKey", "")
    logger.info("Route: %s", route)

    try:
        if route == "POST /upload-url":
            return create_upload_url(event)
        if route == "POST /confirm":
            return confirm_upload(event)
        if route == "GET /images":
            return list_images()
        if route == "POST /delete":
            return delete_image(event)
        return _response(404, {"message": "Route not found."})
    except ValueError:
        return _response(400, {"message": "Invalid request. Please send valid JSON."})
    except ClientError:
        logger.exception("AWS error while handling %s", route)
        return _response(500, {"message": "Something went wrong. Please try again later."})
