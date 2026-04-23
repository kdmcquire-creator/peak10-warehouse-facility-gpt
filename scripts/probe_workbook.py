from pathlib import Path
from app.parser import parse_workbook

if __name__ == "__main__":
    path = Path("../P10 Corp Model_04.2026 v01.xlsx")
    if not path.exists():
        print("Workbook not found beside repo.")
    else:
        parsed = parse_workbook(path.read_bytes(), path.name)
        print(parsed.model_dump_json(indent=2)[:8000])
