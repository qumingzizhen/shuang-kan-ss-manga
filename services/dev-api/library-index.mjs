import { open } from "node:fs/promises";

const maximumHeaderBytes = 256 * 1024;
const maximumCacheEntries = 5_000;

export function compareNaturalPageNames(left, right) {
  return String(left).localeCompare(String(right), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

export function createLibraryImageInspector(options = {}) {
  const maximumEntries = Math.max(Number(options.maximumEntries || maximumCacheEntries), 100);
  const cache = new Map();

  return {
    async inspect(filePath, fileStat) {
      const key = `${filePath}\0${fileStat.size}\0${fileStat.mtimeMs}`;
      const cached = cache.get(key);
      if (cached) {
        return cached;
      }

      const result = await inspectImageFile(filePath, fileStat.size);
      cache.set(key, result);
      while (cache.size > maximumEntries) {
        cache.delete(cache.keys().next().value);
      }
      return result;
    },
    clear() {
      cache.clear();
    },
    get size() {
      return cache.size;
    },
  };
}

export async function inspectImageFile(filePath, sizeBytes) {
  const size = Math.max(Number(sizeBytes || 0), 0);
  if (size < 10) {
    return invalidImage("文件过小，无法包含完整图片");
  }

  let file;
  try {
    file = await open(filePath, "r");
    const headerLength = Math.min(size, maximumHeaderBytes);
    const header = Buffer.allocUnsafe(headerLength);
    const headerRead = await file.read(header, 0, headerLength, 0);
    const payload = header.subarray(0, headerRead.bytesRead);
    const tailLength = Math.min(size, 32);
    const tail = Buffer.allocUnsafe(tailLength);
    const tailRead = await file.read(tail, 0, tailLength, size - tailLength);
    return inspectImageBytes(payload, tail.subarray(0, tailRead.bytesRead), size);
  } catch (error) {
    return invalidImage(error instanceof Error ? error.message : String(error));
  } finally {
    await file?.close().catch(() => undefined);
  }
}

export function inspectImageBytes(header, tail = header, declaredSize = header.length) {
  if (isPng(header)) {
    const width = header.readUInt32BE(16);
    const height = header.readUInt32BE(20);
    const complete = tail.includes(Buffer.from("IEND"));
    return dimensionsResult("png", width, height, complete ? null : "PNG 缺少 IEND 结束块");
  }

  if (isJpeg(header)) {
    const dimensions = jpegDimensions(header);
    const complete = tail.length >= 2 && tail.at(-2) === 0xff && tail.at(-1) === 0xd9;
    if (!dimensions) {
      return invalidImage("JPEG 头部未找到尺寸段", "jpeg");
    }
    return dimensionsResult("jpeg", dimensions.width, dimensions.height, complete ? null : "JPEG 缺少结束标记");
  }

  if (header.subarray(0, 6).toString("ascii") === "GIF87a" || header.subarray(0, 6).toString("ascii") === "GIF89a") {
    const width = header.readUInt16LE(6);
    const height = header.readUInt16LE(8);
    return dimensionsResult("gif", width, height, tail.includes(0x3b) ? null : "GIF 缺少结束标记");
  }

  if (header.subarray(0, 4).toString("ascii") === "RIFF" && header.subarray(8, 12).toString("ascii") === "WEBP") {
    const declaredRiffSize = header.readUInt32LE(4) + 8;
    const dimensions = webpDimensions(header);
    if (!dimensions) {
      return invalidImage("WEBP 头部未找到尺寸信息", "webp");
    }
    return dimensionsResult(
      "webp",
      dimensions.width,
      dimensions.height,
      declaredRiffSize <= declaredSize ? null : "WEBP 声明长度超过实际文件",
    );
  }

  if (header.subarray(0, 2).toString("ascii") === "BM" && header.length >= 26) {
    const width = Math.abs(header.readInt32LE(18));
    const height = Math.abs(header.readInt32LE(22));
    const declaredFileSize = header.readUInt32LE(2);
    return dimensionsResult("bmp", width, height, declaredFileSize <= declaredSize ? null : "BMP 声明长度超过实际文件");
  }

  return invalidImage("图片签名不受支持或文件头损坏");
}

function isPng(header) {
  return header.length >= 24 && header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
}

function isJpeg(header) {
  return header.length >= 4 && header[0] === 0xff && header[1] === 0xd8;
}

function jpegDimensions(header) {
  let offset = 2;
  while (offset + 8 < header.length) {
    if (header[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = header[offset + 1];
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01) {
      offset += 2;
      continue;
    }
    const segmentLength = header.readUInt16BE(offset + 2);
    if (segmentLength < 2 || offset + segmentLength + 2 > header.length) {
      return null;
    }
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return {
        height: header.readUInt16BE(offset + 5),
        width: header.readUInt16BE(offset + 7),
      };
    }
    offset += segmentLength + 2;
  }
  return null;
}

function webpDimensions(header) {
  const chunk = header.subarray(12, 16).toString("ascii");
  if (chunk === "VP8X" && header.length >= 30) {
    return {
      width: 1 + header.readUIntLE(24, 3),
      height: 1 + header.readUIntLE(27, 3),
    };
  }
  if (chunk === "VP8L" && header.length >= 25 && header[20] === 0x2f) {
    const bits = header.readUInt32LE(21);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    };
  }
  if (chunk === "VP8 " && header.length >= 30 && header[23] === 0x9d && header[24] === 0x01 && header[25] === 0x2a) {
    return {
      width: header.readUInt16LE(26) & 0x3fff,
      height: header.readUInt16LE(28) & 0x3fff,
    };
  }
  return null;
}

function dimensionsResult(format, width, height, error) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1 || width > 100_000 || height > 100_000) {
    return invalidImage("图片尺寸无效", format);
  }
  return {
    valid: !error,
    format,
    width,
    height,
    error,
  };
}

function invalidImage(error, format = null) {
  return {
    valid: false,
    format,
    width: null,
    height: null,
    error,
  };
}
