const COMPONENT = { x: 0, y: 1, z: 2, w: 3 };

/** Execute the captured assembly, without reimplementing its lighting tree. */
export function executeIrisPixelShader(shader, {
  constantRegisters,
  viewPosition,
  vertexColor = [1, 1, 1, 1],
  destinationColor = [0.5, 0.5, 0.5, 1],
  imageColor = [1, 1, 1, 1],
  destinationCoordinate = [0.2, 0.3, 1],
}) {
  const registers = Object.fromEntries(Object.entries(constantRegisters)
    .map(([name, value]) => [name, [...value]]));
  // Shader-local DEF constants override the API constant register values.
  for (const [name, value] of Object.entries(shader.defs)) registers[name] = [...value];
  registers.v1 = [...vertexColor];
  registers.v2 = [...viewPosition, 0, 0].slice(0, 4);
  registers.v3 = [...destinationCoordinate, 0].slice(0, 4);
  registers.v4 = [0.4, 0.5, 0, 0];
  const textureReads = [];

  function read(source) {
    const negate = source.startsWith("-");
    const [name, mask = "xyzw"] = (negate ? source.slice(1) : source).split(".");
    const value = registers[name];
    if (!value) throw new Error(`Uninitialized shader register: ${name}`);
    const swizzle = mask.length === 1 ? mask.repeat(4) : mask.padEnd(4, mask.at(-1));
    return [...swizzle].map(component => (negate ? -1 : 1) * value[COMPONENT[component]]);
  }

  function write(destination, value) {
    const [name, mask = "xyzw"] = destination.split(".");
    registers[name] ??= [0, 0, 0, 0];
    for (const component of mask) registers[name][COMPONENT[component]] = value[COMPONENT[component]];
  }

  for (const instruction of shader.instructions) {
    const separator = instruction.indexOf(" ");
    const opcode = instruction.slice(0, separator);
    const [destination, ...sources] = instruction.slice(separator + 1).split(",").map(value => value.trim());
    let value;
    if (opcode === "texld") {
      const [coordinate, sampler] = sources;
      textureReads.push({ sampler, coordinate: read(coordinate) });
      if (sampler === "s0") value = [...destinationColor];
      else if (sampler === "s1") value = [...imageColor];
      else throw new Error(`Unsupported captured sampler: ${sampler}`);
    } else {
      const input = sources.map(read);
      switch (opcode) {
        case "add": value = input[0].map((x, i) => x + input[1][i]); break;
        case "mul":
        case "mul_sat": value = input[0].map((x, i) => x * input[1][i]); break;
        case "mad": value = input[0].map((x, i) => x * input[1][i] + input[2][i]); break;
        case "mov": value = input[0]; break;
        case "frc": value = input[0].map(x => x - Math.floor(x)); break;
        case "rcp": value = input[0].map(x => 1 / x); break;
        case "rsq": value = input[0].map(x => 1 / Math.sqrt(Math.abs(x))); break;
        case "dp3": {
          const dot = input[0].slice(0, 3).reduce((sum, x, i) => sum + x * input[1][i], 0);
          value = Array(4).fill(dot);
          break;
        }
        case "dp2add": {
          const dot = input[0][0] * input[1][0] + input[0][1] * input[1][1] + input[2][0];
          value = Array(4).fill(dot);
          break;
        }
        default: throw new Error(`Unsupported captured opcode: ${opcode}`);
      }
      if (opcode.endsWith("_sat")) value = value.map(x => Math.min(1, Math.max(0, x)));
    }
    write(destination, value);
  }
  return { color: registers.oC0, registers, textureReads };
}

/** D3DCOLOR stores little-endian packed ARGB, rather than RGBA floats. */
export function unpackIrisArgb(packed) {
  return [packed >>> 16 & 255, packed >>> 8 & 255, packed & 255, packed >>> 24 & 255]
    .map(channel => channel / 255);
}

export function irisInstructionSlots(shader) {
  // The two DP2ADD instructions cost two slots; 2D TEXLD costs one.
  return shader.instructions.reduce((count, instruction) => count + (instruction.startsWith("dp2add ") ? 2 : 1), 0);
}
