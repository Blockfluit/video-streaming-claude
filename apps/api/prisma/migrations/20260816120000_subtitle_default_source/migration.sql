-- Whether a video's default subtitle track was chosen by hand.
--
-- The same contract as `ArtworkSource`: AUTO is re-derived whenever the track
-- list changes, MANUAL is never reapplied over. A separate enum rather than a
-- reused one, because it answers a different question and a shared enum is how
-- two unrelated columns end up migrating together.
--
-- It sits on the video rather than on a `Subtitle` row because "deliberately no
-- default" is a valid manual choice and no track can represent one.
--
-- Additive, and every existing row is already correct: nothing has ever elected
-- a default, so AUTO is exactly true of all of them. Nothing to hand-edit.

CREATE TYPE "SubtitleDefaultSource" AS ENUM ('AUTO', 'MANUAL');

ALTER TABLE "Video"
  ADD COLUMN "subtitleDefaultSource" "SubtitleDefaultSource" NOT NULL DEFAULT 'AUTO';
