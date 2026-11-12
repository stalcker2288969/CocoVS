"""Keep CoCAS CdM-16 debug locations section-relative during instruction relaxation."""

from cocas.assembler.targets import IVaryingLengthSegment
from cocas.main import main


update_surroundings = IVaryingLengthSegment.update_surroundings


def update_debug_locations(diff, pos, section, labels):
    # CoCAS passes an absolute PC to this method. The section's labels use
    # that coordinate space, while its source map is indexed by section offset.
    locations = section.code_locations
    section.code_locations = {}
    update_surroundings(diff, pos, section, labels)
    offset = pos - section.address
    section.code_locations = {
        address + (diff if address > offset else 0): location
        for address, location in locations.items()
    }


IVaryingLengthSegment.update_surroundings = staticmethod(update_debug_locations)
raise SystemExit(main())

