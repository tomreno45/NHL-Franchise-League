import csv, json, re, sys

CURRENT_SEASON_START = 2026  # 2026-27 season

def parse_name(raw):
    # "Last, First" or "Last Multi, First" -> "First Last Multi"
    parts = raw.split(",", 1)
    if len(parts) == 2:
        last, first = parts[0].strip(), parts[1].strip()
        return f"{first} {last}"
    return raw.strip()

def parse_row(name_raw, row_text):
    name = parse_name(name_raw)

    # position: "posX,Y" for skaters, "catchesL"/"catchesR" for goalies, or blank if "pos" alone
    pos = ""
    m = re.search(r'\bpos([A-Za-z,]*)', row_text)
    if m and m.group(1):
        pos = m.group(1)
    elif re.search(r'\bcatches[LR]\b', row_text):
        pos = "G"
    else:
        m2 = re.search(r'age\d+\s*([A-Z][A-Za-z]*(?:,[A-Za-z]+)*)', row_text)
        if m2:
            pos = m2.group(1)

    # all real (non-zero) salary figures, in order, as raw ints
    salary_matches = re.findall(r'\$([\d,]+)\$[\d.]+[MK]', row_text)
    salaries = [int(s.replace(",", "")) for s in salary_matches if s != "0"]

    # all "$0 STATUS [year]" expiry markers, in order
    markers = re.findall(r'\$0\s*(UFA-Group6|UFA-G6|UFA|RFA)(?:\s+(\d{4}))?', row_text)

    if not salaries:
        # fully unsigned
        statuses = [m[0] for m in markers]
        status_str = "Unsigned " + "/".join(dict.fromkeys(statuses)) if statuses else "Unsigned"
        return {"Player": name, "Position": pos, "AAV": "", "RemainingYears": "", "Status": status_str}

    # use the most common salary figure as AAV (handles bridge-year-then-extension cases,
    # e.g. a player on the last year of an ELC before a new multi-year deal kicks in)
    from collections import Counter
    aav = Counter(salaries).most_common(1)[0][0]

    # find a marker with an explicit year -> authoritative remaining-years source
    year_marker = next((m for m in markers if m[1]), None)
    if year_marker:
        remaining = int(year_marker[1]) - CURRENT_SEASON_START
    else:
        remaining = len(salaries)

    statuses = [m[0] for m in markers]
    status_str = " then ".join(dict.fromkeys(statuses)) if statuses else ""

    return {"Player": name, "Position": pos, "AAV": f"${aav:,}", "RemainingYears": remaining, "Status": status_str}

def build_csv(json_path, out_csv, roster_split_index=None, roster_labels=None):
    """roster_split_index: list of counts per section in order encountered (for RosterStatus labeling), optional."""
    with open(json_path, encoding="utf-8") as f:
        data = json.load(f)

    rows = [parse_row(d["name"], d["rowText"]) for d in data]

    with open(out_csv, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["Player", "Position", "AAV", "RemainingYears", "ContractStatusAtExpiry"])
        for r in rows:
            w.writerow([r["Player"], r["Position"], r["AAV"], r["RemainingYears"], r["Status"]])

    print(f"Wrote {len(rows)} players to {out_csv}")
    return rows

if __name__ == "__main__":
    json_path, out_csv = sys.argv[1], sys.argv[2]
    build_csv(json_path, out_csv)
