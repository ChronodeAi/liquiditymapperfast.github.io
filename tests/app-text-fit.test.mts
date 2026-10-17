import test from 'node:test';
import assert from 'node:assert/strict';
import { fitText } from '../src/app/text-fit.ts';

// What a canvas would measure: six pixels a letter.
const six = (text: string): number => text.length * 6;

test('a text that fits is left as it is, and so is an empty one', () => {
  assert.equal(fitText(six, 'depth recorded from 02:12', 200), 'depth recorded from 02:12');
  assert.equal(fitText(six, 'abc', 18), 'abc', 'exactly as wide as the room');
  assert.equal(fitText(six, '', 0), '');
});

test('a text that does not fit ends in an ellipsis at the longest start that does, whole words or not', () => {
  const cut = fitText(six, 'Grey: the current book copied back', 120);
  assert.equal(cut, 'Grey: the current b…', 'twenty letters, the ellipsis one of them');
  assert.ok(six(cut) <= 120);
  assert.ok(six(fitText(six, 'Grey: the current book copied back', 121)) <= 121, 'whatever the room, the result fits it');
  for (let room = 6; room < 220; room += 7) assert.ok(six(fitText(six, 'Grey: the current book copied back', room)) <= room, `room ${room}`);
  assert.equal(fitText(six, 'Серый: текущий стакан', 60), 'Серый: те…', 'any alphabet');
});

test('a start that ends in a space does not keep it in front of the ellipsis, and room for nothing leaves the ellipsis alone', () => {
  assert.equal(fitText(six, 'one two three', 30), 'one…', 'cut after a space: the space goes');
  assert.equal(fitText(six, 'abcdef', 3), '…', 'not even one letter fits');
  assert.equal(fitText(six, 'abcdef', 0), '…');
});
