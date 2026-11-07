import importlib.util
import os
import pathlib
import tempfile
import unittest
from unittest import mock

SCRIPT = pathlib.Path(__file__).resolve().parents[1] / 'scripts/prepare_management_key.py'
spec = importlib.util.spec_from_file_location('prepare_management_key', SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PreparationTest(unittest.TestCase):
    def test_swap_cleans_pinned_directory(self):
        with tempfile.TemporaryDirectory(dir=pathlib.Path.home()) as root:
            parent = pathlib.Path(root) / 'parent'
            parent.mkdir(mode=0o700)
            target = parent / 'private'
            target.mkdir(mode=0o700)
            moved = parent / 'moved'
            original = module.verify_path
            outputs_before_swap = []
            def swap(*args):
                outputs_before_swap.extend((target / name).is_file() for name in
                                           ('management-key', 'management-key.sql'))
                target.rename(moved)
                target.symlink_to(moved, target_is_directory=True)
                return original(*args)
            with mock.patch.object(module, 'verify_path', side_effect=swap) as verify:
                with self.assertRaises(OSError):
                    module.prepare(str(target), 'tenant_test')
            verify.assert_called_once()
            self.assertEqual(outputs_before_swap, [True, True])
            self.assertTrue(moved.is_dir())
            self.assertTrue(target.is_symlink())
            self.assertFalse((moved / 'management-key').exists())
            self.assertFalse((moved / 'management-key.sql').exists())

    def test_unsafe_ancestor_and_symlink_rejected(self):
        with tempfile.TemporaryDirectory(dir=pathlib.Path.home()) as root:
            parent = pathlib.Path(root) / 'writable'
            parent.mkdir(mode=0o700)
            target = parent / 'private'
            target.mkdir(mode=0o700)
            parent.chmod(0o777)
            with self.assertRaises(Exception):
                module.prepare(str(target), 'tenant_test')
            parent.chmod(0o700)
            link = pathlib.Path(root) / 'link'
            link.symlink_to(target, target_is_directory=True)
            with self.assertRaises(Exception):
                module.prepare(str(link), 'tenant_test')
            self.assertFalse((target / 'management-key').exists())

    def test_unsupported_platform_rejected(self):
        with tempfile.TemporaryDirectory(dir=pathlib.Path.home()) as root:
            with mock.patch.object(module, 'SUPPORTED', False):
                with self.assertRaises(Exception):
                    module.prepare(root, 'tenant_test')
            self.assertEqual(list(pathlib.Path(root).iterdir()), [])

    def test_cleanup_failure_warns(self):
        with tempfile.TemporaryDirectory(dir=pathlib.Path.home()) as root:
            path = pathlib.Path(root)
            (path / 'management-key.sql').write_text('keep')
            with mock.patch.object(module.os, 'unlink', side_effect=OSError('injected')):
                with self.assertRaisesRegex(Exception, 'cleanup failed'):
                    module.prepare(root, 'tenant_test')
            self.assertTrue((path / 'management-key').exists())
            self.assertEqual((path / 'management-key.sql').read_text(), 'keep')


if __name__ == '__main__':
    unittest.main()
