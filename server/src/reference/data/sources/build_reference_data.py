#!/usr/bin/env python3
"""Rebuild the committed reference JSON (ports, Schedule K, countries) from primary sources.

    python3 server/src/reference/data/sources/build_reference_data.py [download_dir]

Python 3 standard library only. Downloads (or reuses files already in download_dir):
  - Census Schedule D district/port list            https://www.census.gov/foreign-trade/schedules/d/dist.txt
  - CBP port directory (per-state pages)            https://www.cbp.gov/about/contact/ports
  - USACE Schedule K (2nd Quarter 2026, xlsx)       https://ndclibrary.sec.usace.army.mil/resource?documentId=8c90a43a-eaa8-4e2c-ad13-13a9f3ed2b92
  - Census Schedule C country list (Census -> ISO)  https://www.census.gov/foreign-trade/schedules/c/country.txt
  - ISO 3166 names / alpha-3 (datasets/country-codes, derived from ISO + UN M49)
        https://raw.githubusercontent.com/datasets/country-codes/main/data/country-codes.csv
Writes: ../us-ports.json, ../schedule-k.json, ../countries.json
"""
import csv
import io
import json
import os
import re
import sys
import urllib.request
import xml.etree.ElementTree as ET
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.dirname(HERE)
UA = {'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36'}

SCHED_D = 'https://www.census.gov/foreign-trade/schedules/d/dist.txt'
CBP_PORTS = 'https://www.cbp.gov/about/contact/ports'
SCHED_K_DOC = '8c90a43a-eaa8-4e2c-ad13-13a9f3ed2b92'
SCHED_K = f'https://ndclibrary.sec.usace.army.mil/api/download?id={SCHED_K_DOC}&filename=Schedule%20K%202nd%20Quarter%202026.xlsx&token=&preview=false'
SCHED_C = 'https://www.census.gov/foreign-trade/schedules/c/country.txt'
ISO_CSV = 'https://raw.githubusercontent.com/datasets/country-codes/main/data/country-codes.csv'


def fetch(url, path):
    if os.path.exists(path):
        return open(path, 'rb').read()
    req = urllib.request.Request(url, headers=UA)
    data = urllib.request.urlopen(req, timeout=120).read()
    open(path, 'wb').write(data)
    return data


def build_us_ports(dl):
    census = {}
    for line in fetch(SCHED_D, os.path.join(dl, 'dist.txt')).decode('latin-1').splitlines():
        m = re.match(r'^\s*\|\s*(\d{4})\s*\|\s*(.+?)\s*$', line)
        if m:
            census[m.group(1)] = m.group(2)
    index = fetch(CBP_PORTS, os.path.join(dl, 'cbp_ports.html')).decode('utf-8', 'ignore')
    states = sorted(set(re.findall(r'href="/about/contact/ports/([a-z]{2})"', index)))
    cbp = {}
    for st in states:
        html = fetch(f'{CBP_PORTS}/{st}', os.path.join(dl, f'cbp_{st}.html')).decode('utf-8', 'ignore')
        for m in re.finditer(r'<a[^>]+href="/about/contact/ports/[a-z0-9-]+-(\d{4})"[^>]*>(.*?)</a>', html, re.S):
            text = re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', '', m.group(2))).strip()
            text = re.sub(r'\s*[-–]\s*\d{4}\s*$', '', text)
            cbp.setdefault(m.group(1), (text, st.upper()))
    ports = []
    for code in sorted(set(census) | set(cbp)):
        name = cbp[code][0] if code in cbp else census[code]
        name = re.sub(r'(, [A-Za-z .]+)\1$', r'\1', name)  # "Tacoma, Washington, Washington"
        state = cbp[code][1] if code in cbp else None
        if not state:
            m = re.search(r',\s*([A-Z]{2})\b', census.get(code, ''))
            state = m.group(1) if m else None
        aliases = [census[code]] if code in census and code in cbp and census[code].upper() != name.upper() else []
        label = (name + ' ' + ' '.join(aliases)).upper()
        if re.search(r'\b(UPS|FEDEX|DHL|TNT|EXPRESS|HUB|ECCF|COURIER|AIRBORNE|IBC|AVION)\b', label):
            kind = 'courier'
        elif re.search(r'AIRPORT|ARPT|\bAIRPT\b', label):
            kind = 'air'
        else:
            kind = 'port'
        ports.append({'code': code, 'name': name, 'state': state, 'kind': kind, 'aliases': aliases,
                      'source': 'cbp' if code in cbp and code in census else ('cbp-only' if code in cbp else 'census-only')})
    return ports


def read_xlsx_rows(data):
    z = zipfile.ZipFile(io.BytesIO(data))
    ns = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
    strings = []
    if 'xl/sharedStrings.xml' in z.namelist():
        for si in ET.fromstring(z.read('xl/sharedStrings.xml')).findall(f'{ns}si'):
            strings.append(''.join(t.text or '' for t in si.iter(f'{ns}t')))
    rows = []
    for r in ET.fromstring(z.read('xl/worksheets/sheet1.xml')).iter(f'{ns}row'):
        vals = {}
        for c in r.findall(f'{ns}c'):
            col = re.match(r'[A-Z]+', c.attrib['r']).group(0)
            v = c.find(f'{ns}v')
            t = c.attrib.get('t')
            if t == 's' and v is not None:
                vals[col] = strings[int(v.text)]
            elif t == 'inlineStr':
                vals[col] = ''.join(x.text or '' for x in c.iter(f'{ns}t'))
            else:
                vals[col] = v.text if v is not None else ''
        rows.append(vals)
    return rows


def census_to_iso(dl):
    out = {}
    for line in fetch(SCHED_C, os.path.join(dl, 'schc.txt')).decode('latin-1').splitlines():
        m = re.match(r'^(\d{4})\s*\|\s*(.+?)\s*\|\s*([A-Z]{2})\s*$', line)
        if m:
            out[m.group(1)] = (m.group(3), m.group(2))
    return out


# Schedule K country codes that are absent from the 2014 Schedule C text file (checked by name).
SCHED_K_EXTRA_COUNTRIES = {'2775': 'BQ', '2776': 'MF', '7320': 'SD', '7720': 'NA'}


def build_schedule_k(dl, c2iso):
    rows = read_xlsx_rows(fetch(SCHED_K, os.path.join(dl, 'schedule_k.xlsx')))[1:]
    ports = []
    for r in rows:
        code, name, ccode, cname, kind = r.get('A', ''), r.get('B', '').strip(), r.get('C', ''), r.get('D', ''), r.get('H', '')
        if not re.match(r'^\d{5}$', code) or not name:
            continue
        if re.match(r'(?i)^(military-|all other )', name) or cname in ('Undisclosed', 'Unknown'):
            continue
        iso = c2iso.get(ccode, (None,))[0] or SCHED_K_EXTRA_COUNTRIES.get(ccode)
        if not iso:
            print('no ISO for', ccode, cname, file=sys.stderr)
            continue
        ports.append([code, name, iso, 1 if kind == 'Official' else 0])
    return ports


def build_countries(dl, c2iso):
    rows = list(csv.DictReader(io.StringIO(fetch(ISO_CSV, os.path.join(dl, 'country-codes.csv')).decode('utf-8'))))
    by = {}
    for r in rows:
        a2, a3 = r['ISO3166-1-Alpha-2'], r['ISO3166-1-Alpha-3']
        if not a2 or not a3:
            continue
        names = []
        for k in ('CLDR display name', 'official_name_en', 'UNTERM English Short', 'UNTERM English Formal'):
            v = re.sub(r'\s*\(the\)\s*$', '', (r.get(k) or '').strip())
            if v and v not in names:
                names.append(v)
        by[a2] = {'a2': a2, 'a3': a3, 'name': names[0] if names else a2, 'names': names}
    for _, (iso, name) in c2iso.items():
        if iso in by and name not in by[iso]['names']:
            by[iso]['names'].append(name)
    return [by[k] for k in sorted(by)]


def main():
    dl = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, '.download')
    os.makedirs(dl, exist_ok=True)
    c2iso = census_to_iso(dl)
    us = build_us_ports(dl)
    json.dump({'_source': [SCHED_D, CBP_PORTS], 'ports': us}, open(os.path.join(OUT, 'us-ports.json'), 'w'), indent=1)
    k = build_schedule_k(dl, c2iso)
    json.dump({'_source': 'USACE Schedule K 2nd Quarter 2026 (' + SCHED_K + ')', '_columns': ['code', 'name', 'iso2', 'official'], 'ports': k},
              open(os.path.join(OUT, 'schedule-k.json'), 'w'), separators=(',', ':'))
    countries = build_countries(dl, c2iso)
    json.dump({'_source': [ISO_CSV, SCHED_C], 'countries': countries}, open(os.path.join(OUT, 'countries.json'), 'w'), indent=1)
    print(f'us ports {len(us)}, schedule K rows {len(k)}, countries {len(countries)}')


if __name__ == '__main__':
    main()
