"""Regression coverage for the worker without loading torch or model weights."""
import importlib.util
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('qwen_worker', Path(__file__).resolve().parents[1] / 'desktop/qwen_worker.py')
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class ProcessorFixture:
    # Fixtures follow Qwen's encode_timestamp contract, including its CJK split.
    tokens = {
        '"Mr.': ['Mr'], 'Mordred,"': ['Mordred'], 'no,': ['no'], 'no!': ['no'],
        'Meet': ['Meet'], '王Arthur!': ['王', 'Arthur'], 'now.': ['now'],
        '---': [], '42': ['42'],
    }

    def encode_timestamp(self, text, language):
        assert language == 'English'
        return self.tokens[text], 'unused-model-input'


def aligned(*values):
    return [SimpleNamespace(text=text, start_time=start, end_time=end) for text, start, end in values]


class WorkerRegressionTests(unittest.TestCase):
    def test_ending_song_mislabeled_english_is_not_english_dialogue(self):
        # Actual cached ASR text at the user's failing chunk 50 and next chunk.
        for text in ['小さな出た愛は風を彷徨う届かない運命が。', '嘲笑我，为了这世界，我，为了，你，我，']:
            self.assertEqual(worker.english_skip_reason('English', text), 'non-latin-transcript')
        self.assertEqual(worker.english_skip_reason('Japanese', 'a song'), 'non-english-language')

    def test_english_names_numbers_and_mixed_text_are_retained(self):
        for text in ['Nothing changes in this world.', 'Jeanne d’Arc, déjà vu!', 'Meet 王Arthur! now.', '42', '']:
            self.assertIsNone(worker.english_skip_reason('English', text))
        self.assertEqual(worker.english_skip_reason('English', '... ♪'), 'no-speech-text')

    def test_punctuation_and_repeated_words_keep_their_own_timestamps(self):
        result = worker.restore_word_spans(ProcessorFixture(), '"Mr. Mordred," no, no!', aligned(
            ('Mr', 1, 1.2), ('Mordred', 1.3, 2), ('no', 2.2, 2.4), ('no', 2.6, 2.9)), 49)
        self.assertEqual(result, [
            {'text': '"Mr.', 'start': 1, 'end': 1.2},
            {'text': 'Mordred,"', 'start': 1.3, 'end': 2},
            {'text': 'no,', 'start': 2.2, 'end': 2.4},
            {'text': 'no!', 'start': 2.6, 'end': 2.9},
        ])

    def test_several_aligner_units_map_to_one_original_word_without_fake_times(self):
        result = worker.restore_word_spans(ProcessorFixture(), 'Meet 王Arthur! --- now.', aligned(
            ('Meet', .1, .4), ('王', .6, .8), ('Arthur', .9, 1.4), ('now', 2, 2.4)), 50)
        self.assertEqual(result, [
            {'text': 'Meet', 'start': .1, 'end': .4},
            {'text': '王Arthur!', 'start': .6, 'end': 1.4},
            {'text': 'now.', 'start': 2, 'end': 2.4},
        ])

    def test_missing_or_reordered_units_still_fail_instead_of_silently_dropping_words(self):
        for items in [aligned(('Meet', .1, .4)), aligned(('Arthur', .1, .4), ('王', .5, .6))]:
            with self.assertRaisesRegex(ValueError, 'token mismatch at chunk 50'):
                worker.restore_word_spans(ProcessorFixture(), '王Arthur!', items, 50)

    def test_invalid_predictions_are_rejected_and_zero_duration_is_preserved(self):
        for start, end in [(2, 1), (float('nan'), 1), (0, float('inf'))]:
            with self.assertRaisesRegex(ValueError, 'invalid timestamps at chunk 50'):
                worker.restore_word_spans(ProcessorFixture(), '42', aligned(('42', start, end)), 50)
        self.assertEqual(worker.restore_word_spans(ProcessorFixture(), '42', aligned(('42', 1, 1)), 50),
                         [{'text': '42', 'start': 1, 'end': 1}])


if __name__ == '__main__':
    unittest.main()
