#!/usr/bin/env python3
"""Release-artifact gate: fail when an asset is the wrong machine, dynamic, or
page-size incompatible. This checks the *published* binary, not the source.

    python scripts/check_binary.py --format elf --machine arm64 --static \
        --min-page-size 16384 target/aarch64-unknown-linux-musl/release/jeikcode
"""

from __future__ import annotations

import argparse
import struct
import sys
from pathlib import Path

ELF_MACHINE = {"x64": 62, "arm64": 183}
PE_MACHINE = {"x64": 0x8664, "arm64": 0xAA64}
MACHO_CPU = {"x64": 0x01000007, "arm64": 0x0100000C}


def fail(message: str) -> None:
    print(f"check_binary: {message}", file=sys.stderr)
    raise SystemExit(1)


def check_elf(path: Path, machine: str, static: bool, min_page_size: int) -> None:
    data = path.read_bytes()
    if data[:4] != b"\x7fELF":
        fail(f"{path}: not an ELF file")
    is64 = data[4] == 2
    little = data[5] == 1
    endian = "<" if little else ">"

    e_machine = struct.unpack_from(f"{endian}H", data, 18)[0]
    if e_machine != ELF_MACHINE[machine]:
        fail(f"{path}: ELF machine {e_machine:#x} != {ELF_MACHINE[machine]:#x} ({machine})")

    if is64:
        e_phoff = struct.unpack_from(f"{endian}Q", data, 32)[0]
        e_phentsize = struct.unpack_from(f"{endian}H", data, 54)[0]
        e_phnum = struct.unpack_from(f"{endian}H", data, 56)[0]
        p_type_off, p_align_off, p_align_fmt = 0, 48, "Q"
    else:
        e_phoff = struct.unpack_from(f"{endian}I", data, 28)[0]
        e_phentsize = struct.unpack_from(f"{endian}H", data, 42)[0]
        e_phnum = struct.unpack_from(f"{endian}H", data, 44)[0]
        p_type_off, p_align_off, p_align_fmt = 0, 28, "I"

    aligns: list[int] = []
    for index in range(e_phnum):
        offset = e_phoff + index * e_phentsize
        p_type = struct.unpack_from(f"{endian}I", data, offset + p_type_off)[0]
        if p_type == 3:  # PT_INTERP
            fail(f"{path}: has PT_INTERP (dynamic executable, libc will be required)")
        if p_type == 1:  # PT_LOAD
            aligns.append(struct.unpack_from(f"{endian}{p_align_fmt}", data, offset + p_align_off)[0])

    if static and not aligns:
        fail(f"{path}: no PT_LOAD segments found")
    if aligns and min(aligns) < min_page_size:
        fail(f"{path}: PT_LOAD align {min(aligns)} < required {min_page_size}")

    print(f"{path}: ELF {machine} ok, static={static}, min_align={min(aligns) if aligns else 'n/a'}")


def check_pe(path: Path, machine: str) -> None:
    data = path.read_bytes()
    if data[:2] != b"MZ":
        fail(f"{path}: not a PE file (missing MZ header)")
    if len(data) < 0x40:
        fail(f"{path}: truncated DOS header")
    pe_offset = struct.unpack_from("<I", data, 0x3C)[0]
    if data[pe_offset : pe_offset + 4] != b"PE\0\0":
        fail(f"{path}: missing PE signature")
    pe_machine = struct.unpack_from("<H", data, pe_offset + 4)[0]
    if pe_machine != PE_MACHINE[machine]:
        fail(f"{path}: PE machine {pe_machine:#x} != {PE_MACHINE[machine]:#x} ({machine})")
    print(f"{path}: PE {machine} ok")


def check_macho(path: Path, machine: str) -> None:
    data = path.read_bytes()[:8]
    if len(data) < 8:
        fail(f"{path}: truncated Mach-O header")
    magic = struct.unpack_from("<I", data, 0)[0]
    if magic not in (0xFEEDFACF, 0xFEEDFACE):
        fail(f"{path}: not a little-endian Mach-O file")
    cputype = struct.unpack_from("<i", data, 4)[0]
    if cputype != MACHO_CPU[machine]:
        fail(f"{path}: Mach-O cputype {cputype:#x} != {MACHO_CPU[machine]:#x} ({machine})")
    print(f"{path}: Mach-O {machine} ok")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("binary", type=Path)
    parser.add_argument("--format", choices=["elf", "pe", "macho"], required=True)
    parser.add_argument("--machine", choices=["x64", "arm64"], required=True)
    parser.add_argument("--static", action="store_true")
    parser.add_argument("--min-page-size", type=int, default=4096)
    args = parser.parse_args()

    if not args.binary.is_file():
        fail(f"{args.binary}: missing artifact")
    if args.format == "elf":
        check_elf(args.binary, args.machine, args.static, args.min_page_size)
    elif args.format == "pe":
        check_pe(args.binary, args.machine)
    else:
        check_macho(args.binary, args.machine)


if __name__ == "__main__":
    main()
