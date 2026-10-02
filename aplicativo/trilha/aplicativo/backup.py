"""Cria um backup consistente do banco e dos arquivos locais do AudTrilhas."""

from __future__ import annotations

import json
import sqlite3
import uuid
import zipfile
from datetime import datetime
from pathlib import Path

import banco


def create_backup() -> Path:
    banco.initialize_database()
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    destination = banco.BACKUPS_DIR / f"audtrilhas_backup_{stamp}.zip"
    snapshot = banco.TEMP_DIR / f"audtrilhas_{uuid.uuid4().hex}.db"
    source_connection = banco.connect()
    target_connection = sqlite3.connect(snapshot)
    try:
        source_connection.backup(target_connection)
    finally:
        target_connection.close()
        source_connection.close()

    manifest = {
        "createdAt": datetime.now().astimezone().isoformat(timespec="seconds"),
        "database": "banco/audtrilhas.db",
        "includes": ["arquivos/originais", "arquivos/processados", "exportacoes", "logs"],
    }
    try:
        with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            archive.write(snapshot, "banco/audtrilhas.db")
            archive.writestr("manifesto_backup.json", json.dumps(manifest, ensure_ascii=False, indent=2))
            for folder_name in ("arquivos", "exportacoes", "logs"):
                folder = banco.DATA_DIR / folder_name
                if not folder.exists():
                    continue
                for item in folder.rglob("*"):
                    if item.is_file():
                        archive.write(item, item.relative_to(banco.DATA_DIR).as_posix())
    finally:
        snapshot.unlink(missing_ok=True)
    return destination


if __name__ == "__main__":
    backup = create_backup()
    print(f"Backup criado com sucesso:\n{backup}")
