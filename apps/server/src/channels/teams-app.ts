import { crc32, deflateSync } from "node:zlib";

/**
 * The Teams app IT uploads in the Teams admin center: a manifest naming the company's bot, and its
 * two icons, in a zip. Everything is made here; nothing is downloaded.
 */

const BRAND = [0x6d, 0x4a, 0xff] as const;

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** An RGBA image as a PNG. */
export function png(width: number, height: number, rgba: Uint8Array): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8 bits, RGBA, deflate, no filter, no interlace
  const rows = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(rows, y * (width * 4 + 1) + 1);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** The mark: a ring with a dot, smoothed at its edges. `coverage` is how much of a pixel it covers. */
function mark(size: number, x: number, y: number): number {
  const c = size / 2;
  const d = Math.hypot(x + 0.5 - c, y + 0.5 - c);
  const ring = Math.min(1, Math.max(0, Math.min(d - size * 0.24, size * 0.34 - d) + 0.5));
  const dot = Math.min(1, Math.max(0, size * 0.1 - d + 0.5));
  return Math.max(ring, dot);
}

/** The color icon (192×192): the mark in white on the brand color. */
export function colorIcon(size = 192): Buffer {
  const pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const a = mark(size, x, y);
      const i = (y * size + x) * 4;
      pixels[i] = Math.round(BRAND[0] + (255 - BRAND[0]) * a);
      pixels[i + 1] = Math.round(BRAND[1] + (255 - BRAND[1]) * a);
      pixels[i + 2] = Math.round(BRAND[2] + (255 - BRAND[2]) * a);
      pixels[i + 3] = 255;
    }
  }
  return png(size, size, pixels);
}

/** The outline icon (32×32): the mark in white on transparent, as Teams asks. */
export function outlineIcon(size = 32): Buffer {
  const pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      pixels.set([255, 255, 255, Math.round(255 * mark(size, x, y))], i);
    }
  }
  return png(size, size, pixels);
}

/** Files in a zip, stored (the icons are compressed already, the manifest is small). */
export function zip(files: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const crc = crc32(file.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0x21, 12); // date: 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(file.data.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, file.data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // made by
    central.writeUInt16LE(20, 6); // needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(file.data.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + file.data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** The Teams app manifest (v1.17): a personal bot, the company's name, the app's address. */
export function teamsManifest(input: { appId: string; companyName: string; publicUrl: string }): Record<string, unknown> {
  const site = input.publicUrl.replace(/\/$/, "");
  return {
    $schema: "https://developer.microsoft.com/json-schemas/teams/v1.17/MicrosoftTeams.schema.json",
    manifestVersion: "1.17",
    version: "1.0.0",
    id: input.appId,
    developer: { name: cut(input.companyName, 32), websiteUrl: site, privacyUrl: site, termsOfUseUrl: site },
    name: { short: cut(`${input.companyName} AI`, 30), full: cut(`AI employees of ${input.companyName}`, 100) },
    description: {
      short: cut("Give work to your AI employees and answer what they ask", 80),
      full: cut(
        `Your AI employees at ${input.companyName} work here with you. Write what an AI employee should do, starting with its name; it follows the work until it is done and tells you here. Approvals and questions arrive as cards you can act on, and a summary each morning. Everything is also in the app: ${site}`,
        4000,
      ),
    },
    icons: { color: "color.png", outline: "outline.png" },
    accentColor: "#6D4AFF",
    bots: [
      {
        botId: input.appId,
        scopes: ["personal"],
        isNotificationOnly: false,
        supportsFiles: false,
        commandLists: [
          {
            scopes: ["personal"],
            commands: [
              { title: "help", description: "What your AI employees can do here" },
              { title: "what needs me", description: "Approvals and questions waiting for you" },
              { title: "switch", description: "Talk to another AI employee" },
            ],
          },
        ],
      },
    ],
    permissions: ["identity", "messageTeamMembers"],
    validDomains: [new URL(site).host],
  };
}

export function teamsAppPackage(input: { appId: string; companyName: string; publicUrl: string }): Buffer {
  return zip([
    { name: "manifest.json", data: Buffer.from(JSON.stringify(teamsManifest(input), null, 2), "utf8") },
    { name: "color.png", data: colorIcon() },
    { name: "outline.png", data: outlineIcon() },
  ]);
}
