#!/usr/bin/env python3
"""Prepare local management credentials, without connecting to a service."""
import hashlib
import os
import re
import secrets
import stat
import sys

SUPPORTED = (hasattr(os, 'O_NOFOLLOW') and hasattr(os, 'O_DIRECTORY') and
             all(fn in os.supports_dir_fd for fn in (os.open, os.unlink)) and
             hasattr(os, 'getuid'))
FLAGS = os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0) | getattr(os, 'O_NOFOLLOW', 0)
REPOSITORY = os.path.realpath(os.path.join(os.path.dirname(__file__), '../..'))


def checked_directory(fd, final=False):
    info = os.fstat(fd)
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid not in (0, os.getuid()) or
            info.st_mode & 0o022 or
            (final and (info.st_uid != os.getuid() or info.st_mode & 0o077))):
        raise ValueError('unsafe directory')
    return (info.st_dev, info.st_ino)


def open_path(path):
    if not SUPPORTED or not os.path.isabs(path) or '..' in path.split('/'):
        raise ValueError('unsupported platform or path')
    parts = [p for p in path.split('/') if p and p != '.']
    if not parts:
        raise ValueError('invalid directory')
    repository = os.stat(REPOSITORY)
    repo_id = (repository.st_dev, repository.st_ino)
    fd = os.open('/', FLAGS)
    try:
        identities = [checked_directory(fd)]
        for index, part in enumerate(parts):
            child = os.open(part, FLAGS, dir_fd=fd)
            os.close(fd)
            fd = child
            identity = checked_directory(fd, index == len(parts) - 1)
            if identity == repo_id:
                raise ValueError('repository output prohibited')
            identities.append(identity)
        return fd, identities
    except BaseException:
        os.close(fd)
        raise


def verify_path(path, identities):
    fd, current = open_path(path)
    os.close(fd)
    if current != identities:
        raise ValueError('directory path changed')


def prepare(path, tenant):
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', tenant):
        raise ValueError('invalid tenant')
    fd, identities = open_path(path)
    created = []
    try:
        token = secrets.token_urlsafe(32)
        digest = hashlib.sha256(token.encode('ascii')).hexdigest()
        sql = ("INSERT INTO api_keys (key_hash, tenant_id, revoked_at) VALUES "
               f"(CASE WHEN (SELECT count(*) FROM tenants) = 1 AND EXISTS (SELECT 1 FROM tenants WHERE id='{tenant}') AND NOT EXISTS "
               f"(SELECT 1 FROM api_keys) THEN '{digest}' ELSE NULL END, '{tenant}', NULL);\n")
        for name, content in (('management-key', token), ('management-key.sql', sql)):
            out = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
            created.append(name)
            try:
                info = os.fstat(out)
                if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or
                        stat.S_IMODE(info.st_mode) != 0o600 or info.st_dev != identities[-1][0] or info.st_nlink != 1):
                    raise ValueError('unsafe output')
                with os.fdopen(out, 'w', encoding='ascii') as stream:
                    out = -1
                    stream.write(content)
            finally:
                if out != -1:
                    os.close(out)
        verify_path(path, identities)
    except BaseException as error:
        failed = False
        for name in created:
            try:
                os.unlink(name, dir_fd=fd)
            except OSError:
                failed = True
        if failed:
            raise RuntimeError('cleanup failed; both output files may require secure removal') from error
        raise
    finally:
        os.close(fd)


def main():
    try:
        if len(sys.argv) != 3:
            raise ValueError('invalid arguments')
        prepare(sys.argv[1], sys.argv[2])
    except Exception as error:
        print('Preparation failed. Use a secure absolute directory outside the repository, a valid tenant ID, and unused output names.', file=sys.stderr)
        if isinstance(error, RuntimeError):
            print('WARNING: cleanup failed; both output files may require secure removal from the original directory.', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
