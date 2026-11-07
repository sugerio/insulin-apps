#!/usr/bin/env python3
"""Manual synthetic management client. Never prints credentials or response bodies."""
import argparse
import http.client
import json
import os
import re
import stat
import sys
from urllib.parse import urlsplit, quote

from prepare_management_key import open_path, verify_path

MAX_BODY = 16384

class Stop(Exception):
    pass

def identifier(value):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', value):
        raise ValueError('invalid identifier')
    return value

def check_origin(origin):
    u = urlsplit(origin)
    if (u.scheme != 'https' or not u.hostname or u.username is not None or u.password is not None or
        u.path or u.query or u.fragment or u.port is not None or
        not re.fullmatch(r'[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?)+', u.hostname) or
        origin != 'https://' + u.hostname):
        raise ValueError('invalid origin')
    return origin

def read_key(fd):
    f = os.open('management-key', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
    try:
        s = os.fstat(f)
        if not stat.S_ISREG(s.st_mode) or s.st_uid != os.getuid() or stat.S_IMODE(s.st_mode) != 0o600 or s.st_nlink != 1:
            raise ValueError('invalid key file')
        key = os.read(f, 257).decode('ascii')
        if not re.fullmatch(r'[A-Za-z0-9_-]{32,256}', key): raise ValueError('invalid key')
        return key
    finally: os.close(f)

def reserve_url(fd, name):
    return os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)

def write_url(out, path, ids, url):
    try:
        info = os.fstat(out)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1:
            raise Stop()
        with os.fdopen(out, 'w', encoding='ascii') as stream:
            out = -1
            stream.write(url + '\n')
        verify_path(path, ids)
    finally:
        if out != -1: os.close(out)

def request(origin, key, method, path, body=None, idem=None):
    conn = http.client.HTTPSConnection(urlsplit(origin).hostname, timeout=20)
    headers = {'Authorization': 'Bearer ' + key, 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; SyntheticOperator/1.0)'}
    data = None
    if body is not None:
        data = json.dumps(body, separators=(',', ':')).encode()
        headers['Content-Type'] = 'application/json'
    if idem: headers['Idempotency-Key'] = identifier(idem)
    try:
        conn.request(method, path, body=data, headers=headers)
        response = conn.getresponse()
        raw = response.read(MAX_BODY + 1)
        if response.status != 200 or len(raw) > MAX_BODY: raise Stop()
        result = json.loads(raw)
        if not isinstance(result, dict): raise Stop()
        return result
    except (OSError, http.client.HTTPException, ValueError, UnicodeError):
        raise Stop() from None
    finally: conn.close()

def safe_id(data, name):
    try: return identifier(data.get(name))
    except (ValueError, AttributeError): raise Stop() from None

def main():
    parser = argparse.ArgumentParser(description='Synthetic only. Never supply secrets as arguments.')
    parser.add_argument('--origin', required=True, help='exact approved canonical HTTPS origin')
    parser.add_argument('--private-dir', required=True, help='absolute private directory containing management-key')
    sub = parser.add_subparsers(dest='action', required=True)
    e = sub.add_parser('editor'); e.add_argument('role1'); e.add_argument('role2')
    r = sub.add_parser('result'); r.add_argument('page_id')
    c = sub.add_parser('envelope'); c.add_argument('template_id'); c.add_argument('idempotency_key'); c.add_argument('role1'); c.add_argument('name1'); c.add_argument('email1'); c.add_argument('role2'); c.add_argument('name2'); c.add_argument('email2')
    for action in ('prepare', 'tasks'):
        p = sub.add_parser(action); p.add_argument('envelope_id')
    v = sub.add_parser('view'); v.add_argument('envelope_id'); v.add_argument('task_id')
    args = parser.parse_args()
    fd = None
    output = None
    try:
        origin = check_origin(args.origin)
        fd, ids = open_path(args.private_dir)
        key = read_key(fd)
        verify_path(args.private_dir, ids)
        if args.action == 'editor':
            roles = [identifier(args.role1), identifier(args.role2)]
            if roles[0] == roles[1]: raise ValueError()
            output = reserve_url(fd, 'editor-url')
            data = request(origin, key, 'POST', '/v1/editor-sessions', {'origin': origin, 'roles': roles})
            page, code = safe_id(data, 'pageId'), safe_id(data, 'code')
            if not re.fullmatch(r'[a-f0-9]{64}', page): raise Stop()
            out, output = output, None
            write_url(out, args.private_dir, ids, origin + '/candidate-editor.html#pageId=' + quote(page, safe='') + '&code=' + quote(code, safe=''))
            print('Editor URL stored privately; page ID: ' + page)
        elif args.action == 'result':
            if not re.fullmatch(r'[a-f0-9]{64}', args.page_id): raise ValueError()
            data = request(origin, key, 'GET', '/v1/editor-sessions/' + args.page_id + '/result')
            print('Template ID: ' + safe_id(data, 'templateId'))
        elif args.action == 'envelope':
            roles = [identifier(args.role1), identifier(args.role2)]
            emails = [args.email1, args.email2]
            if roles[0] == roles[1] or emails[0] == emails[1] or any(not re.fullmatch(r'[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+\.test', x) for x in emails): raise ValueError()
            recipients = [{'role': roles[i], 'name': [args.name1,args.name2][i], 'email': emails[i]} for i in range(2)]
            data = request(origin, key, 'POST', '/v1/envelopes', {'templateId': identifier(args.template_id), 'recipients': recipients}, args.idempotency_key)
            print('Envelope ID: ' + safe_id(data, 'id'))
        elif args.action == 'prepare':
            request(origin, key, 'POST', '/v1/envelopes/' + identifier(args.envelope_id) + '/prepare')
            print('Prepared.')
        elif args.action == 'tasks':
            data = request(origin, key, 'GET', '/v1/envelopes/' + identifier(args.envelope_id) + '/tasks')
            tasks = data.get('tasks')
            if not isinstance(tasks, list) or len(tasks) != 2: raise Stop()
            if any(not isinstance(t, dict) or t.get('routingOrder') != i + 1 for i, t in enumerate(tasks)): raise Stop()
            items = [(safe_id(t, 'id'), safe_id(t, 'role')) for t in tasks]
            for task_id, role in items: print('Task ID: ' + task_id + ' role: ' + role)
        else:
            path = '/v1/envelopes/' + identifier(args.envelope_id) + '/tasks/' + identifier(args.task_id) + '/recipient-view'
            output = reserve_url(fd, 'recipient-url-' + identifier(args.task_id))
            data = request(origin, key, 'POST', path, {'origin': origin})
            code = safe_id(data, 'code')
            out, output = output, None
            write_url(out, args.private_dir, ids, origin + '/candidate.html#code=' + quote(code, safe=''))
            print('Recipient URL stored privately.')
        return 0
    except (Stop, ValueError, OSError, UnicodeError):
        print('Stopped. Do not retry a mutation: its result may be lost. Establish settlement and inspect state privately before any recovery. Check private output files.', file=sys.stderr)
        return 1
    finally:
        if output is not None: os.close(output)
        if fd is not None: os.close(fd)

if __name__ == '__main__': sys.exit(main())
