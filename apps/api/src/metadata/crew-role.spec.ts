import { creditRoleForJob, KEY_CREW_JOBS } from './crew-role';

describe('creditRoleForJob', () => {
  it('maps the jobs the library has a role for', () => {
    expect(creditRoleForJob('Director')).toBe('DIRECTOR');
    expect(creditRoleForJob('Writer')).toBe('WRITER');
    expect(creditRoleForJob('Screenplay')).toBe('WRITER');
    expect(creditRoleForJob('Story')).toBe('WRITER');
    expect(creditRoleForJob('Teleplay')).toBe('WRITER');
    expect(creditRoleForJob('Producer')).toBe('PRODUCER');
    expect(creditRoleForJob('Executive Producer')).toBe('PRODUCER');
    expect(creditRoleForJob('Original Music Composer')).toBe('COMPOSER');
    expect(creditRoleForJob('Director of Photography')).toBe('CINEMATOGRAPHER');
    expect(creditRoleForJob('Editor')).toBe('EDITOR');
  });

  /**
   * The whole reason the table is matched exactly rather than by `includes`.
   * TMDB's crew list is full of jobs that *contain* a key job as a substring,
   * and every one of them would be promoted by a looser match — a first
   * assistant director credited as the director of the film is not a small
   * error, it is the wrong name at the top of the panel.
   */
  it('does not promote a job that merely contains a key job', () => {
    expect(creditRoleForJob('Assistant Director')).toBe('OTHER');
    expect(creditRoleForJob('Second Unit Director')).toBe('OTHER');
    expect(creditRoleForJob('First Assistant Editor')).toBe('OTHER');
    expect(creditRoleForJob('Assistant Producer')).toBe('OTHER');
    expect(creditRoleForJob('Music Editor')).toBe('OTHER');
    expect(creditRoleForJob('Casting Director')).toBe('OTHER');
    expect(creditRoleForJob('Art Direction')).toBe('OTHER');
  });

  it('keeps everything else rather than dropping it', () => {
    expect(creditRoleForJob('Costume Designer')).toBe('OTHER');
    expect(creditRoleForJob('Stunt Coordinator')).toBe('OTHER');
    expect(creditRoleForJob('Boom Operator')).toBe('OTHER');
  });

  /**
   * Whitespace and case are the sort of thing a data source varies without
   * warning, and a job that fails to match is silently demoted to OTHER rather
   * than erroring — so the normalisation has to be here, not hoped for.
   */
  it('reads a job whatever the case and spacing', () => {
    expect(creditRoleForJob('  director  ')).toBe('DIRECTOR');
    expect(creditRoleForJob('DIRECTOR OF PHOTOGRAPHY')).toBe('CINEMATOGRAPHER');
  });

  it('treats a missing or blank job as OTHER rather than throwing', () => {
    expect(creditRoleForJob('')).toBe('OTHER');
    expect(creditRoleForJob('   ')).toBe('OTHER');
  });

  /**
   * The panel shows key crew by default and hides the rest behind a toggle, so
   * "which jobs are key" has to be one list rather than a rule restated in the
   * frontend.
   */
  it('exports the key jobs, and OTHER is not one of them', () => {
    expect(KEY_CREW_JOBS.length).toBeGreaterThan(0);
    for (const job of KEY_CREW_JOBS) {
      expect(creditRoleForJob(job)).not.toBe('OTHER');
    }
  });
});
