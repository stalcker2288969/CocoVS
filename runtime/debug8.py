"""Run a persistent CdM-8 CPU for the CocoVS debug adapter."""

import json
import sys

from cpu8 import CPU


class Machine:
    def __init__(self, args):
        image = bytes.fromhex(args["image"])
        architecture = args["architecture"]
        self.cpu = CPU(image, image if architecture == "vonNeumann" else bytes(256), architecture)
        self.locations = args["locations"]
        self.limit = args["limit"]
        self.frames = []
        self.steps = 0
        self.stack_bytes = 0

    def location(self):
        return self.locations.get(str(self.cpu.pc))

    def execute(self, args):
        cpu = self.cpu
        mode = args["mode"]
        start_line = args["startLine"]
        depth = args["depth"]
        breakpoints = set(args["breakpoints"])
        for index in range(256):
            if not (index == 0 and args["skipFirst"]):
                if cpu.pc in breakpoints:
                    return self.state("breakpoint")
                if mode != "continue" and self.steps != args["startSteps"]:
                    new_line = (self.location() is None or self.location() != start_line
                                or cpu.pc == args["startPc"])
                    current_depth = len(self.frames)
                    if (mode == "instruction"
                            or mode == "in" and (new_line or current_depth != depth)
                            or mode == "over" and (current_depth < depth or current_depth == depth and new_line)
                            or mode == "out" and current_depth < depth):
                        return self.state("step")
            if self.steps >= self.limit:
                return self.state("limit", f"Reached {self.limit} instructions.")

            address, sp = cpu.pc, cpu.sp
            opcode = cpu.code[address]
            stopped = cpu.step()
            self.steps += 1
            delta = (cpu.sp - sp + 128) % 256 - 128
            self.stack_bytes = 0 if opcode == 0xCD else min(256, max(0, self.stack_bytes - delta))
            if opcode in (0xD6, 0xDA):  # JSR and CRC (used by JSRR)
                self.frames.append({"call": address, "sp": cpu.sp, "return": cpu.ram[cpu.sp]})
            elif opcode == 0xD7 and self.frames:
                frame = self.frames[-1]
                if sp == frame["sp"] and cpu.pc == frame["return"]:
                    self.frames.pop()
            if stopped:
                return self.state(*stopped)
        return self.state("running")

    def state(self, reason, detail=""):
        cpu = self.cpu
        return {
            "reason": reason, "detail": detail, "steps": self.steps,
            "pc": cpu.pc, "sp": cpu.sp, "ps": cpu.ps, "registers": cpu.registers,
            "stackBytes": self.stack_bytes, "ram": cpu.ram.hex(), "frames": [frame["call"] for frame in self.frames],
        }


def main():
    machine = None
    for line in sys.stdin:
        try:
            request = json.loads(line)
            if request["command"] == "start":
                machine = Machine(request)
                result = machine.state("entry")
            elif request["command"] == "execute" and machine is not None:
                result = machine.execute(request)
            else:
                raise ValueError("Invalid emulator command.")
        except (ValueError, TypeError, KeyError) as error:
            result = {"error": str(error)}
        print(json.dumps(result), flush=True)


if __name__ == "__main__":
    main()
