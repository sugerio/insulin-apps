"""models.py: the pinned models (F112). The cache must hold exactly the pinned commit of each repo with every file
matching its checksum, and the data format must name the embedding model; the Dockerfile fetches the pins, warms up
offline and verifies."""

from __future__ import annotations

import hashlib
import re
import tempfile
import unittest
from pathlib import Path

import _paths  # noqa: F401
import models

DOCKERFILE = (Path(models.__file__).parent / "Dockerfile").read_text()


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class Pins(unittest.TestCase):
    def setUp(self):
        self.saved = (models.MODELS, models.EMBEDDING_REPO)
        models.MODELS = {"example/embed": ("a" * 40, {"model.onnx": sha(b"weights"), "sub/config.json": sha(b"{}")})}
        models.EMBEDDING_REPO = "example/embed"
        self.dir = tempfile.TemporaryDirectory()
        self.cache = Path(self.dir.name)
        snapshot = self.cache / "models--example--embed" / "snapshots" / ("a" * 40)
        (snapshot / "sub").mkdir(parents=True)
        (snapshot / "model.onnx").write_bytes(b"weights")
        (snapshot / "sub" / "config.json").write_bytes(b"{}")
        (self.cache / "models--example--embed" / "refs").mkdir()
        (self.cache / "models--example--embed" / "refs" / "main").write_text("a" * 40)
        self.snapshot = snapshot
        self.format = "cognee-1.6.8+embed@aaaaaaa+knowledge-1"

    def tearDown(self):
        models.MODELS, models.EMBEDDING_REPO = self.saved
        self.dir.cleanup()

    def test_the_pinned_cache_passes(self):
        self.assertEqual(models.problems(self.cache, self.format), [])

    def test_a_changed_file_fails(self):
        (self.snapshot / "model.onnx").write_bytes(b"other weights")
        self.assertEqual(models.problems(self.cache, self.format), ["example/embed: model.onnx does not match its checksum"])

    def test_another_commit_fails(self):
        (self.cache / "models--example--embed" / "snapshots" / ("b" * 40)).mkdir()
        (self.cache / "models--example--embed" / "refs" / "main").write_text("b" * 40)
        found = models.problems(self.cache, self.format)
        self.assertTrue(any("main is not" in p for p in found), found)
        self.assertTrue(any("expected only" in p for p in found), found)

    def test_missing_extra_and_unknown_files_fail(self):
        (self.snapshot / "sub" / "config.json").unlink()
        (self.snapshot / "extra.bin").write_bytes(b"?")
        (self.cache / "models--example--other").mkdir()
        found = models.problems(self.cache, self.format)
        self.assertIn("example/embed: sub/config.json is missing", found)
        self.assertIn("example/embed: extra.bin is not pinned", found)
        self.assertIn("models--example--other: not a pinned model", found)

    def test_the_data_format_must_name_the_embedding_model(self):
        found = models.problems(self.cache, "cognee-1.6.8+knowledge-1")
        self.assertEqual(found, ["KNOWLEDGE_DATA_FORMAT 'cognee-1.6.8+knowledge-1' does not name the embedding model embed@aaaaaaa"])


class Image(unittest.TestCase):
    def test_the_image_names_the_pinned_embedding_model(self):
        data_format = re.search(r"KNOWLEDGE_DATA_FORMAT=(\S+)", DOCKERFILE).group(1)
        self.assertIn(models.embedding_tag(), data_format)

    def test_every_pin_is_a_full_commit_and_sha256(self):
        for repo, (commit, files) in models.MODELS.items():
            self.assertRegex(commit, r"^[0-9a-f]{40}$", repo)
            self.assertTrue(files, repo)
            for path, digest in files.items():
                self.assertRegex(digest, r"^[0-9a-f]{64}$", f"{repo} {path}")

    def test_the_build_fetches_the_pins_warms_up_offline_then_verifies(self):
        run = DOCKERFILE[DOCKERFILE.index("RUN python /app/models.py fetch") :]
        run = run[: run.index("rm -rf /tmp/warmup")]
        order = [run.index("models.py fetch"), run.index("HF_HUB_OFFLINE=1"), run.index("warmup.py"), run.index("models.py verify")]
        self.assertEqual(order, sorted(order))


if __name__ == "__main__":
    unittest.main()
