/**
 * The palette.
 *
 * Red on near-black, which is the grammar the genre established: artwork
 * supplies all the colour, the chrome supplies none, and the one accent is
 * spent on the thing you are meant to click.
 */
export default defineAppConfig({
  ui: {
    colors: {
      primary: 'red',
      // Zinc rather than slate — slate is faintly blue, and next to warm
      // poster artwork that reads as a colour cast rather than as grey.
      neutral: 'zinc',
    },
  },
})
