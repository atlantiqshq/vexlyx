import importlib.util
import os
from pathlib import Path
import unittest


MODULE_PATH = Path(__file__).parents[1] / "system" / "python" / "git_manager.py"
SPEC = importlib.util.spec_from_file_location("git_manager", MODULE_PATH)
git_manager = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(git_manager)


class TestGitHubAppGitCredentials(unittest.TestCase):
    def test_token_is_supplied_through_process_environment(self):
        token = "temporary-installation-token"
        env = git_manager._build_env(None, token)

        self.assertEqual(env["GIT_CONFIG_COUNT"], "1")
        self.assertEqual(env["GIT_CONFIG_KEY_0"], "http.https://github.com/.extraheader")
        self.assertNotIn(token, env["GIT_CONFIG_VALUE_0"])
        self.assertNotIn(token, str(MODULE_PATH))

    def test_parent_environment_is_not_mutated(self):
        before = dict(os.environ)
        git_manager._build_env(None, "temporary-token")
        self.assertEqual(dict(os.environ), before)


if __name__ == "__main__":
    unittest.main()
