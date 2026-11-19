import importlib.util
import json
from pathlib import Path
import unittest

HERE=Path(__file__).parent
spec=importlib.util.spec_from_file_location("record_navigation",HERE/"record-navigation.py")
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class NavigationReadinessTest(unittest.TestCase):
    def nodes(self,stage):
        source=HERE.parents[1]/"core/src/test/resources/fixtures"/f"chatgpt-1.2026.293-{stage}-redacted.json"
        def walk(n):
            yield n
            for c in n.get("children",[]):yield from walk(c)
        return [n for n in walk(json.loads(source.read_text())) if n.get("visible")]
    def test_visible_reply_text_is_not_completion_while_the_source_still_generates(self):
        items=self.nodes("streamed-reply")
        self.assertTrue(any(n.get("text")=="amber notebook." for n in items))
        self.assertFalse(module.reply_is_complete(items,"amber notebook"))
    def test_actual_finished_reply_has_actions_and_no_generating_control(self):
        self.assertTrue(module.reply_is_complete(self.nodes("complete-reply"),"amber notebook"))

if __name__=="__main__":unittest.main()
