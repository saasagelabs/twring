"""The Hermes build of the Twring skill ships with the plugin and is registered as twring:twring."""

from pathlib import Path

import twring_skill


class FakeContext:
    def __init__(self, error=None):
        self.skills = []
        self.error = error

    def register_skill(self, name, path, description="", frontmatter=None):
        if self.error is not None:
            raise self.error
        self.skills.append((name, Path(path), description))


def test_registers_the_bundled_hermes_skill():
    ctx = FakeContext()
    twring_skill.register_skill(ctx)
    [(name, path, description)] = ctx.skills
    assert name == "twring"
    assert path == twring_skill.SKILL_DIR / "SKILL.md" and path.is_file()
    assert "twring_ring_owner" in description and "twring_message_owner" in description


def test_the_bundled_skill_is_the_hermes_build():
    text = (twring_skill.SKILL_DIR / "SKILL.md").read_text(encoding="utf-8")
    assert text.startswith("---\nname: twring\n")
    assert "  build: hermes\n" in text
    assert "`twring_ring_owner`" in text and "`twring_message_owner`" in text
    for file in twring_skill.SKILL_DIR.rglob("*.md"):
        body = file.read_text(encoding="utf-8")
        assert "Generated from skills/twring" in body, file.name
        for banned in ("twring-connect", "nohup", "curl"):
            assert banned not in body, (file.name, banned)


def test_a_refused_registration_does_not_stop_the_plugin(caplog):
    twring_skill.register_skill(FakeContext(error=ValueError("already registered")))
    assert "Twring skill not registered" in caplog.text
