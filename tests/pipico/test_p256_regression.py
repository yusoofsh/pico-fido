"""
P-256 key generation and assertion-signature regression tests.

Two related checks (see the mission contract VAL-FIDO-006 and VAL-FIDO-007):

- test_p256_repeat_100 performs 100 full register/sign/verify cycles:
  makeCredential with ES256, an on-curve check of every produced public key,
  then getAssertion on a fresh clientDataHash whose ECDSA-SHA256 signature is
  verified with the `cryptography` library. Every credential ID must be
  distinct and the sign counters must follow the upstream semantics.

- test_on_curve_negative proves the on-curve helper is not a no-op by feeding
  it perturbed coordinates that must be rejected.

The tests run against the shared `device` fixture from tests/conftest.py. In
auto mode (the upstream emulation default, and the mode the emulated button
starts in) each cycle's user-presence wait is accepted immediately, exactly
like the plain upstream emulator.
"""

import os
import time

import pytest
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec

BTN_ENV = "PICOKEYS_EMULATION_BUTTON_FILE"
CMD_SETTLE = 0.05

# ES256 (alg -7) and the COSE key parameters produced by the device.
ALG_ES256 = -7

# P-256 (secp256r1 / prime256v1) domain parameters.
P256_P = 0xFFFFFFFF00000001000000000000000000000000FFFFFFFFFFFFFFFFFFFFFFFF
P256_A = P256_P - 3
P256_B = 0x5AC635D8AA3A93E7B3EBBD55769886BC651D06B0CC53B0F63BCE3C3E27D2604B

ITERATIONS = 100


@pytest.fixture(autouse=True)
def _auto_button():
    """Run in auto mode (and clear any timeout override) when the emulated
    button control exists; a missing control file already means auto."""
    if os.environ.get(BTN_ENV):
        for cmd in ("timeout:0", "auto"):
            tmp = os.environ[BTN_ENV] + ".tmp"
            with open(tmp, "w") as f:
                f.write(cmd + "\n")
            os.replace(tmp, os.environ[BTN_ENV])
            time.sleep(CMD_SETTLE)
    yield


def point_on_curve_p256(x, y):
    """Return True iff (x, y) is a valid affine P-256 public key point.

    Checks the coordinate range (0 <= x, y < p, which also excludes the
    point at infinity: an affine encoding has no representation for it) and
    the curve equation y^2 = x^3 - 3x + b (mod p).
    """
    if not isinstance(x, int) or not isinstance(y, int):
        return False
    if not (0 <= x < P256_P and 0 <= y < P256_P):
        return False
    lhs = (y * y) % P256_P
    rhs = (x * x * x + P256_A * x + P256_B) % P256_P
    return lhs == rhs


def cose_key_coords(public_key):
    """Extract (kty, alg, crv, x, y) from a device-produced COSE key."""
    assert public_key[1] == 2, f"kty is not EC2: {public_key[1]}"
    assert public_key[3] == ALG_ES256, f"alg is not ES256: {public_key[3]}"
    assert public_key[-1] == 1, f"crv is not P-256: {public_key[-1]}"
    x = int.from_bytes(public_key[-2], "big")
    y = int.from_bytes(public_key[-3], "big")
    assert len(public_key[-2]) == 32, f"x is {len(public_key[-2])} bytes, not 32"
    assert len(public_key[-3]) == 32, f"y is {len(public_key[-3])} bytes, not 32"
    return x, y


def verify_p256_signature(x, y, signature, message):
    """Verify a DER ECDSA-SHA256 signature with the `cryptography` library."""
    pub = ec.EllipticCurvePublicNumbers(x, y, ec.SECP256R1()).public_key()
    pub.verify(signature, message, ec.ECDSA(hashes.SHA256()))


def ctap2(device):
    return device.client()._backend.ctap2


def test_p256_repeat_100(device):
    """"100 register/sign/verify cycles: every key on-curve, every signature
    valid, every credential distinct, counters consistent."""
    ctap = ctap2(device)
    rp = {"id": "p256-repeat.example.com", "name": "P-256 repeat"}
    user = {"id": b"p256-repeat-user", "name": "P-256 repeat user"}
    key_params = [{"type": "public-key", "alg": ALG_ES256}]

    seen_credential_ids = set()
    last_counter = 0
    t0 = time.time()

    for i in range(ITERATIONS):
        # --- register: makeCredential with ES256 on a fresh challenge ---
        mc_hash = os.urandom(32)
        mc = ctap.make_credential(mc_hash, rp, user, key_params, options={"rk": True})
        auth_data = mc.auth_data
        credential = auth_data.credential_data
        credential_id = bytes(credential.credential_id)
        assert credential_id not in seen_credential_ids, f"iteration {i}: duplicate credential ID"
        seen_credential_ids.add(credential_id)

        # The attested public key must be a real P-256 point.
        x, y = cose_key_coords(credential.public_key)
        assert point_on_curve_p256(x, y), (
            f"iteration {i}: public key is not on P-256 (x={x.hex()}, y={y.hex()})"
        )

        # --- sign: getAssertion on a fresh clientDataHash ---
        ga_hash = os.urandom(32)
        ga = ctap.get_assertion(
            rp["id"], ga_hash, allow_list=[{"id": credential_id, "type": "public-key"}]
        )
        assert ga.auth_data.flags & 0x01, f"iteration {i}: UP flag not set"
        assert ga.auth_data.counter > 0, f"iteration {i}: signCount is zero"
        assert ga.auth_data.counter >= last_counter, (
            f"iteration {i}: signCount went backwards "
            f"({ga.auth_data.counter} < {last_counter})"
        )
        last_counter = ga.auth_data.counter

        # --- verify: ECDSA-SHA256 over authData || clientDataHash ---
        verify_p256_signature(
            x, y, ga.signature, bytes(ga.auth_data) + ga_hash
        )

    elapsed = time.time() - t0
    assert len(seen_credential_ids) == ITERATIONS
    print(f"P-256 iterations: {ITERATIONS} (all keys on-curve, all signatures verified) in {elapsed:.1f}s")


def test_on_curve_negative(device):
    """The on-curve helper must reject perturbed points: (x, y+1) of a valid
    key is off the curve, and an x outside the field must be refused, so the
    check cannot be a no-op."""
    # Register once and take a genuine device-produced key.
    ctap = ctap2(device)
    mc = ctap.make_credential(
        os.urandom(32),
        {"id": "p256-negative.example.com", "name": "P-256 negative"},
        {"id": b"p256-negative-user", "name": "P-256 negative user"},
        [{"type": "public-key", "alg": ALG_ES256}],
        options={"rk": True},
    )
    x, y = cose_key_coords(mc.auth_data.credential_data.public_key)

    # Positive control: the genuine key is accepted.
    assert point_on_curve_p256(x, y)

    # Negative: flipping the low bit of y lands off the curve.
    assert not point_on_curve_p256(x, (y + 1) % P256_P)

    # Negative: x at and beyond the field modulus must be refused outright.
    assert not point_on_curve_p256(P256_P, y)
    assert not point_on_curve_p256(P256_P + 1, y)

    # Negative: y beyond the field modulus must be refused too.
    assert not point_on_curve_p256(x, P256_P)
