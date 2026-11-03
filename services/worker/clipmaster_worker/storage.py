"""Almacenamiento de objetos: S3/MinIO (producción) o sistema de archivos local (pruebas)."""

from __future__ import annotations

import json
import re
import shutil
from pathlib import Path
from typing import Protocol

from .config import Settings

_KEY_RE = re.compile(r"^[a-z]+(/[A-Za-z0-9_\-]+)+(\.[a-z0-9]{1,5})?$")


def validate_key(key: str) -> str:
    """Las claves las genera el servidor; aun así se rechaza cualquier intento de traversal."""
    if ".." in key or key.startswith("/") or "\\" in key or not _KEY_RE.match(key):
        raise ValueError(f"Clave de almacenamiento inválida: {key!r}")
    return key


def join_key(prefix: str, name: str) -> str:
    return validate_key(f"{prefix.rstrip('/')}/{name}")


class Storage(Protocol):
    def download(self, key: str, dest: Path) -> Path: ...
    def upload(self, src: Path, key: str, content_type: str) -> int: ...
    def put_json(self, key: str, data: object) -> int: ...
    def input_url(self, key: str, expires: int = 6 * 3600) -> str: ...
    def size(self, key: str) -> int | None: ...
    def delete(self, key: str) -> None: ...


class LocalStorage:
    def __init__(self, root: Path):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    def path(self, key: str) -> Path:
        p = (self.root / validate_key(key)).resolve()
        if self.root.resolve() not in p.parents:
            raise ValueError("Ruta fuera del almacenamiento")
        return p

    def download(self, key: str, dest: Path) -> Path:
        shutil.copyfile(self.path(key), dest)
        return dest

    def upload(self, src: Path, key: str, content_type: str) -> int:
        p = self.path(key)
        p.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, p)
        return p.stat().st_size

    def put_json(self, key: str, data: object) -> int:
        p = self.path(key)
        p.parent.mkdir(parents=True, exist_ok=True)
        raw = json.dumps(data, ensure_ascii=False).encode("utf-8")
        p.write_bytes(raw)
        return len(raw)

    def input_url(self, key: str, expires: int = 6 * 3600) -> str:
        return str(self.path(key))

    def size(self, key: str) -> int | None:
        p = self.path(key)
        return p.stat().st_size if p.exists() else None

    def delete(self, key: str) -> None:
        self.path(key).unlink(missing_ok=True)


class S3Storage:
    def __init__(self, settings: Settings):
        import boto3
        from botocore.config import Config

        self.bucket = settings.s3_bucket
        self.client = boto3.client(
            "s3",
            endpoint_url=settings.s3_endpoint,
            region_name=settings.s3_region,
            aws_access_key_id=settings.s3_access_key,
            aws_secret_access_key=settings.s3_secret_key,
            config=Config(signature_version="s3v4", s3={"addressing_style": "path"}, retries={"max_attempts": 5}),
        )

    def download(self, key: str, dest: Path) -> Path:
        self.client.download_file(self.bucket, validate_key(key), str(dest))
        return dest

    def upload(self, src: Path, key: str, content_type: str) -> int:
        self.client.upload_file(str(src), self.bucket, validate_key(key), ExtraArgs={"ContentType": content_type})
        return src.stat().st_size

    def put_json(self, key: str, data: object) -> int:
        raw = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.client.put_object(Bucket=self.bucket, Key=validate_key(key), Body=raw, ContentType="application/json")
        return len(raw)

    def input_url(self, key: str, expires: int = 6 * 3600) -> str:
        """URL prefirmada interna (red Docker) para que FFmpeg lea con seeks HTTP Range sin descargar todo."""
        return self.client.generate_presigned_url(
            "get_object", Params={"Bucket": self.bucket, "Key": validate_key(key)}, ExpiresIn=expires
        )

    def size(self, key: str) -> int | None:
        try:
            return int(self.client.head_object(Bucket=self.bucket, Key=validate_key(key))["ContentLength"])
        except Exception:
            return None

    def delete(self, key: str) -> None:
        self.client.delete_object(Bucket=self.bucket, Key=validate_key(key))


def make_storage(settings: Settings) -> Storage:
    if settings.storage_backend == "local":
        return LocalStorage(settings.local_storage_dir)
    return S3Storage(settings)
