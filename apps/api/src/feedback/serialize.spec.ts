import { toFeedbackView, type StoredFeedback } from './serialize';

describe('toFeedbackView', () => {
  const row: StoredFeedback = {
    id: 'fb-1',
    message: 'The player is broken on this page',
    pageUrl: '/watch/heat',
    userAgent: 'Mozilla/5.0',
    viewportWidth: 1280,
    viewportHeight: 800,
    hasScreenshot: true,
    createdAt: new Date('2026-09-06T00:00:00.000Z'),
    user: { id: 'user-1', displayName: 'Ada' },
  };

  it('exposes exactly the intended fields', () => {
    expect(toFeedbackView(row)).toEqual({
      id: 'fb-1',
      message: 'The player is broken on this page',
      pageUrl: '/watch/heat',
      userAgent: 'Mozilla/5.0',
      viewportWidth: 1280,
      viewportHeight: 800,
      hasScreenshot: true,
      createdAt: row.createdAt,
      user: { id: 'user-1', displayName: 'Ada' },
    });
  });
});
