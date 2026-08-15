"""Root Windows launcher for IPlay (board path: C:\\Users\\firer\\Iplay\\iplay.pyw)."""
import os
import runpy
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.join(HERE, "iplay", "iplay.pyw")
if not os.path.isfile(APP):
    raise SystemExit(f"IPlay launcher missing: {APP}")
sys.path.insert(0, os.path.join(HERE, "iplay"))
runpy.run_path(APP, run_name="__main__")
