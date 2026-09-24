from __future__ import annotations

import json
import hashlib
import os
from pathlib import Path
import shutil
import sys
import tempfile
import threading
import unittest
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "aplicativo"
sys.path.insert(0, str(APP))


class OfflineIntegrationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.temp_dir = Path(tempfile.mkdtemp(prefix="audtrilhas-test-"))
        os.environ["AUDTRILHAS_DATA_DIR"] = str(cls.temp_dir)
        global banco, servidor
        import banco
        import servidor

        banco.initialize_database()
        cls.server = servidor.LocalServer(("127.0.0.1", 0), servidor.Handler)
        cls.port = cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=3)
        shutil.rmtree(cls.temp_dir, ignore_errors=True)

    def request(self, path: str, method: str = "GET", payload: bytes | None = None, headers: dict[str, str] | None = None):
        request = Request(f"http://127.0.0.1:{self.port}{path}", data=payload, headers=headers or {}, method=method)
        with urlopen(request, timeout=20) as response:
            return response.status, response.headers, response.read()

    def test_complete_local_workflow(self) -> None:
        status, _, body = self.request("/api/health")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["status"], "ok")

        sample = (ROOT / "exemplos" / "extracao_dou_exemplo.csv").read_bytes()
        headers = {"Content-Type": "text/csv", "X-File-Name": "extracao_dou_exemplo.csv", "X-Imported-By": "Teste ASTID"}
        status, _, body = self.request("/api/imports", "POST", sample, headers)
        self.assertEqual(status, 201)
        uploaded = json.loads(body)
        self.assertFalse(uploaded["duplicate"])
        self.assertGreater(len(uploaded["state"]["publications"]), 0)
        self.assertGreater(len(uploaded["state"]["alerts"]), 0)
        batch_id = uploaded["batch"]["id"]
        alert_id = uploaded["state"]["alerts"][0]["id"]
        stored_file = banco.import_file_info(batch_id)
        self.assertFalse(Path(stored_file["original_path"]).is_absolute())
        self.assertFalse(Path(stored_file["processed_path"]).is_absolute())

        status, _, body = self.request(
            f"/api/alerts/{alert_id}",
            "PATCH",
            json.dumps({"status": "Em análise", "notes": "Teste de persistência", "assignedTo": "ASTID", "actor": "Teste automatizado"}).encode(),
            {"Content-Type": "application/json"},
        )
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["alert"]["status"], "Em análise")

        status, _, body = self.request("/api/state")
        state = json.loads(body)
        self.assertTrue(any(alert["id"] == alert_id and alert["status"] == "Em análise" for alert in state["alerts"]))
        self.assertTrue(any(event["alertId"] == alert_id for event in state["events"]))

        status, headers_out, downloaded = self.request(f"/api/imports/{batch_id}/file")
        self.assertEqual(status, 200)
        self.assertEqual(hashlib.sha256(downloaded).digest(), hashlib.sha256(sample).digest())
        self.assertIn("attachment", headers_out.get("Content-Disposition", ""))

        status, _, body = self.request("/api/imports", "POST", sample, headers)
        self.assertEqual(status, 200)
        self.assertTrue(json.loads(body)["duplicate"])

        original_files = list((self.temp_dir / "arquivos" / "originais").rglob("*.csv"))
        processed_files = list((self.temp_dir / "arquivos" / "processados").rglob("*.json"))
        self.assertEqual(len(original_files), 1)
        self.assertEqual(len(processed_files), 1)


if __name__ == "__main__":
    unittest.main()
