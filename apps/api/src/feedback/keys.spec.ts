import { feedbackScreenshotKey } from './keys';

describe('feedbackScreenshotKey', () => {
  it('namespaces the id under feedback/ as a png', () => {
    expect(feedbackScreenshotKey('abc123')).toBe('feedback/abc123.png');
  });
});
