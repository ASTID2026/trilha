"""Servidor HTTP local do AudTrilhas Offline, sem dependências externas."""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
from logging.handlers import RotatingFileHandler
import mimetypes
import os
import re
import shutil
import threading
import unicodedata
import uuid
import webbrowser
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, unquote, urlparse

import banco
from motor_auditoria import fold, make_alerts, normalize_rows, parse_csv_bytes, parse_interest_terms


WEB_DIR = Path(__file__).resolve().parent / "web"
MAX_UPLOAD_BYTES = 25 * 1024 * 1024
MAX_JSON_BYTES = 1024 * 1024


def configure_logging() -> None:
    banco.ensure_directories()
    handler = RotatingFileHandler(banco.LOGS_DIR / "audtrilhas.log", maxBytes=1_000_000, backupCount=5, encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    logging.basicConfig(level=logging.INFO, handlers=[handler, logging.StreamHandler()])


def safe_display_name(value: str) -> str:
    return Path(unquote(value or "arquivo.csv").replace("\\", "/")).name[:180] or "arquivo.csv"


def safe_disk_name(value: str) -> str:
    normalized = unicodedata.normalize("NFD", value)
    ascii_name = "".join(ch for ch in normalized if unicodedata.category(ch) != "Mn")
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "-", ascii_name)
    return re.sub(r"-+", "-", cleaned).strip("-._")[:120] or "arquivo.csv"


def atomic_write(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = banco.TEMP_DIR / f"{uuid.uuid4()}.tmp"
    try:
        with temporary.open("wb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def inside_data(path: Path) -> bool:
    try:
        path.resolve().relative_to(banco.DATA_DIR)
        return True
    except ValueError:
        return False


def remove_managed_file(path: Path | None) -> None:
    if path and path.exists() and path.is_file() and inside_data(path):
        path.unlink()


def process_upload(content: bytes, file_name: str, content_type: str, imported_by: str) -> dict:
    checksum = hashlib.sha256(content).hexdigest()
    duplicate = banco.get_import_by_checksum(checksum)
    if duplicate and banco.import_is_complete(duplicate["id"]):
        banco.activate_imports([duplicate["id"]])
        return {"duplicate": True, "batch": {"id": duplicate["id"], "fileName": duplicate["file_name"]}, "state": banco.get_application_state()}
    if duplicate:
        original, processed = banco.delete_import(duplicate["id"])
        remove_managed_file(original)
        remove_managed_file(processed)

    raw_rows = parse_csv_bytes(content)
    headers = {fold(key) for key in raw_rows[0].keys()} if raw_rows else set()
    if not raw_rows or not headers.intersection({"url", "titulo", "resumo", "data"}):
        raise ValueError("Cabeçalhos do Ro-DOU não reconhecidos. Verifique URL, Título, Resumo e Data.")

    import_id = str(uuid.uuid4())
    publications = normalize_rows(raw_rows, import_id)
    settings = banco.get_application_state()["settings"]
    alerts = make_alerts(
        publications,
        materiality=float(settings.get("materiality", "500000")),
        publication_lag=int(float(settings.get("publicationLag", "30"))),
        interest_terms=parse_interest_terms(settings.get("interestTerms")),
    )
    month = datetime.now().strftime("%Y/%m")
    original_path = banco.ORIGINALS_DIR / month / f"{import_id}__{safe_disk_name(file_name)}"
    processed_path = banco.PROCESSED_DIR / month / f"{import_id}.json"
    snapshot = {
        "metadata": {
            "id": import_id, "fileName": file_name, "checksumSha256": checksum,
            "processedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
            "rowCount": len(publications), "alertCount": len(alerts),
        },
        "publications": publications,
        "alertsAtProcessing": alerts,
    }
    try:
        atomic_write(original_path, content)
        atomic_write(processed_path, json.dumps(snapshot, ensure_ascii=False, indent=2).encode("utf-8"))
        banco.save_import(import_id, file_name, original_path, processed_path, content_type, len(content), checksum, imported_by, publications, alerts)
    except Exception:
        remove_managed_file(original_path)
        remove_managed_file(processed_path)
        raise
    return {"duplicate": False, "batch": {"id": import_id, "fileName": file_name}, "state": banco.get_application_state()}


class LocalServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


class Handler(BaseHTTPRequestHandler):
    server_version = "AudTrilhasOffline/1.0"

    def log_message(self, fmt: str, *args) -> None:
        logging.info("%s - %s", self.client_address[0], fmt % args)

    def _send_headers(self, status: int, content_type: str, length: int | None = None, extra: dict[str, str] | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        if length is not None:
            self.send_header("Content-Length", str(length))
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()

    def send_json(self, payload: dict | list, status: int = 200) -> None:
        data = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self._send_headers(status, "application/json; charset=utf-8", len(data), {"Cache-Control": "no-store"})
        self.wfile.write(data)

    def send_error_json(self, message: str, status: int = 500) -> None:
        logging.warning("API %s %s: %s", self.command, self.path, message)
        self.send_json({"error": message}, status)

    def read_body(self, limit: int) -> bytes:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as exc:
            raise ValueError("Tamanho da requisição inválido.") from exc
        if length <= 0:
            return b""
        if length > limit:
            raise OverflowError("A requisição excede o limite permitido.")
        return self.rfile.read(length)

    def read_json(self) -> dict:
        body = self.read_body(MAX_JSON_BYTES)
        try:
            parsed = json.loads(body.decode("utf-8") or "{}")
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError("Conteúdo JSON inválido.") from exc
        if not isinstance(parsed, dict):
            raise ValueError("O conteúdo deve ser um objeto JSON.")
        return parsed

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        try:
            if path == "/api/health":
                self.send_json({"status": "ok", "database": str(banco.DB_PATH.name)})
                return
            if path in {"/api/state", "/api/imports"}:
                self.send_json(banco.get_application_state())
                return
            match = re.fullmatch(r"/api/imports/([^/]+)/file", path)
            if match:
                self.send_original(unquote(match.group(1)))
                return
            if path.startswith("/api/"):
                self.send_error_json("Rota não encontrada.", 404)
                return
            self.send_static(path)
        except LookupError as exc:
            self.send_error_json(str(exc), 404)
        except Exception as exc:
            logging.exception("Falha no GET %s", path)
            self.send_error_json(str(exc) or "Falha ao carregar os dados.")

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        try:
            if path == "/api/imports":
                content = self.read_body(MAX_UPLOAD_BYTES)
                if not content:
                    raise ValueError("Selecione um arquivo CSV.")
                file_name = safe_display_name(self.headers.get("X-File-Name", "arquivo.csv"))
                if not file_name.lower().endswith(".csv"):
                    raise ValueError("O arquivo deve estar no formato CSV.")
                imported_by = unquote(self.headers.get("X-Imported-By", "Equipe CENCIAR"))[:120]
                result = process_upload(content, file_name, self.headers.get("Content-Type", "text/csv"), imported_by)
                self.send_json(result, 200 if result["duplicate"] else 201)
                return
            if path == "/api/imports/analyze":
                payload = self.read_json()
                ids = [str(item).strip() for item in payload.get("ids", []) if str(item).strip()] if isinstance(payload.get("ids"), list) else []
                banco.activate_imports(ids)
                self.send_json({"state": banco.get_application_state()})
                return
            self.send_error_json("Rota não encontrada.", 404)
        except OverflowError as exc:
            self.send_error_json(str(exc), 413)
        except LookupError as exc:
            self.send_error_json(str(exc), 404)
        except ValueError as exc:
            self.send_error_json(str(exc), 422)
        except Exception as exc:
            logging.exception("Falha no POST %s", path)
            self.send_error_json(str(exc) or "Falha ao processar a solicitação.")

    def do_PATCH(self) -> None:
        path = urlparse(self.path).path
        try:
            payload = self.read_json()
            match = re.fullmatch(r"/api/alerts/([^/]+)", path)
            if match:
                self.send_json({"alert": banco.update_alert(unquote(match.group(1)), payload)})
                return
            match = re.fullmatch(r"/api/trails/([^/]+)", path)
            if match:
                self.send_json({"trail": banco.toggle_trail(unquote(match.group(1)), bool(payload.get("active")))})
                return
            if path == "/api/settings":
                self.send_json({"settings": banco.update_settings(payload), "state": banco.get_application_state()})
                return
            self.send_error_json("Rota não encontrada.", 404)
        except LookupError as exc:
            self.send_error_json(str(exc), 404)
        except ValueError as exc:
            self.send_error_json(str(exc), 400)
        except Exception as exc:
            logging.exception("Falha no PATCH %s", path)
            self.send_error_json(str(exc) or "Falha ao salvar a alteração.")

    def do_DELETE(self) -> None:
        path = urlparse(self.path).path
        try:
            match = re.fullmatch(r"/api/imports/([^/]+)", path)
            if not match:
                self.send_error_json("Rota não encontrada.", 404)
                return
            original, processed = banco.delete_import(unquote(match.group(1)))
            remove_managed_file(original)
            remove_managed_file(processed)
            self.send_json({"state": banco.get_application_state()})
        except LookupError as exc:
            self.send_error_json(str(exc), 404)
        except Exception as exc:
            logging.exception("Falha no DELETE %s", path)
            self.send_error_json(str(exc) or "Falha ao excluir o arquivo.")

    def send_original(self, import_id: str) -> None:
        row = banco.import_file_info(import_id)
        if not row:
            raise LookupError("Arquivo não encontrado.")
        file_path = banco.resolve_data_path(row["original_path"])
        if not file_path.is_file() or not inside_data(file_path):
            raise LookupError("O arquivo original não está disponível na pasta local.")
        content = file_path.read_bytes()
        display_name = safe_display_name(row["file_name"])
        ascii_name = safe_disk_name(display_name).replace('"', "")
        disposition = f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(display_name)}"
        self._send_headers(200, row["content_type"] or "text/csv", len(content), {"Content-Disposition": disposition, "Cache-Control": "no-store"})
        self.wfile.write(content)

    def send_static(self, request_path: str) -> None:
        relative = request_path.lstrip("/") or "index.html"
        candidate = (WEB_DIR / relative).resolve()
        try:
            candidate.relative_to(WEB_DIR.resolve())
        except ValueError:
            self.send_error_json("Caminho inválido.", 400)
            return
        if not candidate.is_file():
            candidate = WEB_DIR / "index.html"
        if not candidate.is_file():
            self.send_error_json("Interface local não encontrada.", 503)
            return
        content = candidate.read_bytes()
        content_type = mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"
        if content_type.startswith("text/") or content_type in {"application/javascript", "image/svg+xml"}:
            content_type += "; charset=utf-8"
        cache = "no-cache" if candidate.name == "index.html" else "public, max-age=31536000, immutable"
        self._send_headers(200, content_type, len(content), {"Cache-Control": cache})
        self.wfile.write(content)


def make_server(host: str, start_port: int) -> tuple[LocalServer, int]:
    last_error: OSError | None = None
    for port in range(start_port, start_port + 20):
        try:
            return LocalServer((host, port), Handler), port
        except OSError as exc:
            last_error = exc
    raise RuntimeError("Não foi possível localizar uma porta livre para iniciar o AudTrilhas.") from last_error


def main() -> None:
    parser = argparse.ArgumentParser(description="AudTrilhas DOU — edição offline")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--init-db", action="store_true")
    args = parser.parse_args()
    configure_logging()
    database = banco.initialize_database()
    if args.init_db:
        print(f"Banco inicializado em: {database}")
        return
    server, port = make_server(args.host, args.port)
    url = f"http://{args.host}:{port}/"
    print("=" * 68)
    print("AudTrilhas DOU — Edição Offline")
    print(f"Endereço local: {url}")
    print("Para encerrar, pressione Ctrl+C nesta janela.")
    print("=" * 68)
    if not args.no_browser:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever(poll_interval=0.4)
    except KeyboardInterrupt:
        print("\nAudTrilhas encerrado.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
