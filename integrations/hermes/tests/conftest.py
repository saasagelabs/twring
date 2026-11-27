import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


import pytest  # noqa: E402


@pytest.fixture(autouse=True)
def _fresh_transport_registry():
    import approval_transport

    approval_transport._registered_for.clear()
    yield
    approval_transport._registered_for.clear()
