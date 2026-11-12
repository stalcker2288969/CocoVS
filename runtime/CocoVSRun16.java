import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.BitSet;
import java.util.HexFormat;
import java.util.Map;
import java.util.Objects;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import java.util.stream.IntStream;

import org.cdm.cocoemu.components.memory.BankedRam;
import org.cdm.cocoemu.components.processors.cdm16.Cdm16;
import org.cdm.cocoemu.components.processors.cdm16.Status;
import org.cdm.cocoemu.components.processors.cdm16e.Cdm16e;
import org.cdm.cocoemu.core.Component;
import org.cdm.cocoemu.core.image.Image;
import org.cdm.cocoemu.systems.HarvardSystem;
import org.cdm.cocoemu.systems.VonNeumannSystem;

/** Executes the Cocoemu core without a WebSocket server. */
public final class CocoVSRun16 {
    private static final int MAX_CYCLES_PER_INSTRUCTION = 128;

    private static boolean instruction(Cdm16 cpu, Component system) {
        for (int cycles = 0; cycles < MAX_CYCLES_PER_INSTRUCTION; cycles++) {
            system.clockRising();
            system.clockFalling();
            system.update();
            if (state(cpu).fetch || state(cpu).status != Status.RUNNING) {
                return true;
            }
        }
        return false;
    }

    private static Cdm16.Outputs state(Cdm16 cpu) {
        return cpu instanceof Cdm16e extended ? extended.outputs : cpu.outputs;
    }

    private record Frame(int call, int sp, int returnAddress) {}

    private static final class DebugMachine {
        private final Cdm16 cpu = new Cdm16();
        private final Component system;
        private final BankedRam ram;
        private final byte[] rom;
        private final int limit;
        private final JsonObject locations;
        private final ArrayList<Frame> frames = new ArrayList<>();
        private int steps;
        private int stackBytes;

        DebugMachine(JsonObject request) {
            byte[] bytes = HexFormat.of().parseHex(request.get("image").getAsString());
            Image image = new Image(IntStream.range(0, bytes.length).map(i -> Byte.toUnsignedInt(bytes[i])).toArray());
            if (request.get("architecture").getAsString().equals("harvard")) {
                HarvardSystem machine = new HarvardSystem(cpu, image);
                system = machine;
                ram = machine.ram;
                rom = bytes;
            } else {
                VonNeumannSystem machine = new VonNeumannSystem(cpu, image);
                system = machine;
                ram = machine.ram;
                rom = ram.getBuffer().array();
            }
            limit = request.get("limit").getAsInt();
            locations = request.getAsJsonObject("locations");
            if (!instruction(cpu, system) || cpu.outputs.status != Status.RUNNING) {
                throw new IllegalStateException("CdM-16 failed to reach its first instruction.");
            }
        }

        Map<String, Object> state(String reason, boolean includeRam) {
            Cdm16.Outputs current = cpu.outputs;
            return Map.of("reason", reason, "steps", steps, "pc", current.pc, "sp", current.sp, "ps", current.ps,
                    "stackBytes", stackBytes, "registers", current.gpRegisters, "frames", frames.stream().mapToInt(Frame::call).toArray(),
                    "ram", includeRam ? HexFormat.of().formatHex(ram.getBuffer().array()) : "");
        }

        Map<String, Object> execute(JsonObject args) {
            String mode = args.get("mode").getAsString();
            int startingSteps = args.get("startSteps").getAsInt();
            int startPc = args.get("startPc").getAsInt();
            int depth = args.get("depth").getAsInt();
            boolean skipFirst = args.get("skipFirst").getAsBoolean();
            BitSet breakpoints = new BitSet();
            args.getAsJsonArray("breakpoints").forEach(address -> breakpoints.set(address.getAsInt()));
            for (int index = 0; index < 256; index++) {
                int pc = cpu.outputs.pc;
                if (index != 0 || !skipFirst) {
                    if (breakpoints.get(pc)) return state("breakpoint", true);
                    var location = locations.get(Integer.toString(pc));
                    boolean newLine = location == null || !Objects.equals(location, args.get("startLine")) || pc == startPc;
                    int frameCount = frames.size();
                    if (steps != startingSteps && switch (mode) {
                        case "instruction" -> true;
                        case "in" -> newLine || frameCount != depth;
                        case "over" -> frameCount < depth || frameCount == depth && newLine;
                        case "out" -> frameCount < depth;
                        default -> false;
                    }) return state("step", true);
                }
                if (steps >= limit) return state("limit", true);
                int sp = cpu.outputs.sp;
                int opcode = Byte.toUnsignedInt(rom[pc]) | Byte.toUnsignedInt(rom[(pc + 1) & 0xffff]) << 8;
                if (!instruction(cpu, system)) return state("cycle_limit", true);
                steps++;
                int delta = (short) (cpu.outputs.sp - sp);
                boolean resetsStack = (opcode & 0xfff8) == 0x2028 || opcode == 0x000d;
                stackBytes = resetsStack ? 0 : Math.min(65536, Math.max(0, stackBytes - delta));
                switch (cpu.outputs.status) {
                    case Status.HALTED -> { return state("halt", true); }
                    case Status.WAITING -> { return state("wait", true); }
                    case Status.FAULT -> { return state("fault", true); }
                    default -> { }
                }
                // JSR immediate, JSR relative and JSR register. RTS expands to POPC.
                if (opcode == 0x0008 || (opcode & 0xfc00) == 0x8c00 || (opcode & 0xfff8) == 0x2018) {
                    frames.add(new Frame(pc, cpu.outputs.sp, (pc + (opcode == 0x0008 ? 4 : 2)) & 0xffff));
                } else if (opcode == 0x000b && !frames.isEmpty()) {
                    Frame frame = frames.get(frames.size() - 1);
                    if (sp == frame.sp() && cpu.outputs.pc == frame.returnAddress()) frames.remove(frames.size() - 1);
                }
            }
            return state("running", false);
        }
    }

    private static void debug() throws Exception {
        var json = new Gson();
        var reader = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        DebugMachine machine = null;
        for (String line; (line = reader.readLine()) != null;) {
            Map<String, Object> result;
            try {
                var request = json.fromJson(line, JsonObject.class);
                switch (request.get("command").getAsString()) {
                    case "start" -> {
                        machine = new DebugMachine(request);
                        result = machine.state("entry", true);
                    }
                    case "execute" -> result = machine.execute(request);
                    case "snapshot" -> result = machine.state("running", true);
                    default -> throw new IllegalArgumentException("Unknown emulator request.");
                }
            } catch (RuntimeException error) {
                result = Map.of("error", error.toString());
            }
            System.out.println(json.toJson(result));
            System.out.flush();
        }
    }

    public static void main(String[] args) throws Exception {
        if (args.length == 1 && args[0].equals("--debug")) {
            debug();
            return;
        }
        byte[] data = Files.readAllBytes(Path.of(args[0]));
        Image image = new Image(IntStream.range(0, data.length)
                .map(index -> Byte.toUnsignedInt(data[index])).toArray());
        Cdm16 cpu = args[4].equals("cdm16e") ? new Cdm16e() : new Cdm16();
        Component system;
        BankedRam ram;
        if (args[1].equals("harvard")) {
            HarvardSystem machine = new HarvardSystem(cpu, image);
            system = machine;
            ram = machine.ram;
        } else {
            VonNeumannSystem machine = new VonNeumannSystem(cpu, image);
            system = machine;
            ram = machine.ram;
        }

        int steps = 0;
        int limit = Integer.parseInt(args[2]);
        String reason = "limit";
        if (!instruction(cpu, system) || state(cpu).status != Status.RUNNING) {
            reason = "boot";
        } else {
            while (steps < limit) {
                if (!instruction(cpu, system)) {
                    reason = "cycle_limit";
                    break;
                }
                steps++;
                reason = switch (state(cpu).status) {
                    case Status.HALTED -> "halt";
                    case Status.WAITING -> "wait";
                    case Status.FAULT -> "fault";
                    default -> "limit";
                };
                if (!reason.equals("limit")) {
                    break;
                }
            }
        }
        Cdm16.Outputs result = state(cpu);
        Files.write(Path.of(args[3]), ram.getBuffer().array());
        System.out.printf("{\"reason\":\"%s\",\"steps\":%d,\"pc\":%d,\"sp\":%d,\"ps\":%d,\"registers\":%s}%n",
                reason, steps, result.pc, result.sp, result.ps, Arrays.toString(result.gpRegisters));
    }
}
