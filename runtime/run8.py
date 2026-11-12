"""Run a CoCAS CdM-8 memory image and report final CPU state."""

import json
import sys
from pathlib import Path

from cpu8 import CPU


def main():
    image_path, architecture, steps_text, ram_path = sys.argv[1:]
    image = Path(image_path).read_bytes().ljust(256, b"\0")
    ram = image if architecture == "vonNeumann" else bytes(256)
    cpu = CPU(image, ram, architecture)
    limit = int(steps_text)
    reason, detail = "limit", f"Reached {limit} instructions"
    for steps in range(1, limit + 1):
        stop = cpu.step()
        if stop is not None:
            reason, detail = stop
            break
    Path(ram_path).write_bytes(cpu.ram)
    print(json.dumps(dict(reason=reason, detail=detail, steps=steps, pc=cpu.pc,
                          sp=cpu.sp, ps=cpu.ps, registers=cpu.registers)))


if __name__ == "__main__":
    main()
