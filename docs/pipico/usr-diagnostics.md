# USR runtime diagnostics

Select the rescue application and send `80 1E 06 00 08` over CCID to read
eight bytes of runtime evidence. The request does not write configuration,
flash, or credentials and does not consume OTP feature reports.

| Byte | Meaning |
| --- | --- |
| 0 | Magic `0x50` |
| 1 | Format version `1` |
| 2 | Bit 0: current GPIO24 level; bit 1: companion disabled at boot; bit 2: last press requested feedback; bit 3: LED accepted that request |
| 3 | Gate flags sampled at the last raw press edge |
| 4 | Raw press-edge count |
| 5 | Classified gesture count |
| 6 | Keyboard enqueue count |
| 7 | Last classified HID usage (`0x68`–`0x6B`) |

Gate flags are auth busy `0x01`, presence pending `0x02`, OTP typing `0x04`,
keyboard enabled `0x08`, mounted `0x10`, suspended `0x20`, transmitter busy
`0x40`, and keyboard endpoint ready `0x80`.

Counters wrap modulo 256 and reset on reboot. Press edges are raw and can
include contact bounce. The snapshot is observational and its individual
bytes can change while read. Polling CCID creates an active command, so
stop polling before performing a gesture; read once before and once after.
