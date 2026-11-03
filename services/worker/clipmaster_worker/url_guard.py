"""
Protección SSRF: sólo http(s) a hosts públicos. Se rechazan IPs privadas, loopback, link-local
(incluido 169.254.169.254 de metadatos cloud), multicast, reservadas, nombres de un solo nivel
(servicios Docker internos como "minio" o "postgres"), credenciales embebidas y puertos no estándar.
Cada redirección se vuelve a validar.
"""

from __future__ import annotations

import ipaddress
import socket
from urllib.parse import urlsplit

ALLOWED_PORTS = {80, 443, 8080, 8443}
BLOCKED_HOSTNAMES = {"localhost", "metadata.google.internal", "metadata", "instance-data"}


class UnsafeUrl(ValueError):
    pass


def _ip_is_public(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    return not (
        ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast
        or ip.is_reserved or ip.is_unspecified or not ip.is_global
    )


def check_url(url: str, *, allow_private: bool = False, resolve: bool = True) -> str:
    """Valida la URL y devuelve el hostname. Lanza UnsafeUrl si no es segura."""
    if len(url) > 2048:
        raise UnsafeUrl("URL demasiado larga")
    parts = urlsplit(url.strip())
    if parts.scheme not in ("http", "https"):
        raise UnsafeUrl("Sólo se admiten URLs http(s)")
    if parts.username or parts.password:
        raise UnsafeUrl("La URL no puede contener credenciales")
    host = (parts.hostname or "").rstrip(".").lower()
    if not host:
        raise UnsafeUrl("URL sin host")
    try:
        port = parts.port or (443 if parts.scheme == "https" else 80)
    except ValueError as exc:
        raise UnsafeUrl("Puerto inválido") from exc
    if allow_private:
        return host
    if port not in ALLOWED_PORTS:
        raise UnsafeUrl("Puerto no permitido")
    if host in BLOCKED_HOSTNAMES or host.endswith((".local", ".internal", ".localhost", ".lan")):
        raise UnsafeUrl("Host no permitido")
    try:
        literal = ipaddress.ip_address(host)
    except ValueError:
        literal = None
    if literal is not None:
        if not _ip_is_public(literal):
            raise UnsafeUrl("Dirección IP no pública")
        return host
    if "." not in host:
        raise UnsafeUrl("Host no permitido")
    if resolve:
        try:
            infos = socket.getaddrinfo(host, port, proto=socket.IPPROTO_TCP)
        except socket.gaierror as exc:
            raise UnsafeUrl("No se pudo resolver el dominio") from exc
        ips = {ipaddress.ip_address(info[4][0].split("%")[0]) for info in infos}
        if not ips or not all(_ip_is_public(ip) for ip in ips):
            raise UnsafeUrl("El dominio resuelve a una red interna")
    return host
