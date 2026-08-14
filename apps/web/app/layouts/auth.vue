<template>
  <!--
    The shell both signed-out screens sit in.

    It exists because they had none. Each page carried its own copy of the
    centring wrapper and its own footer line, which is two chances for the two
    pages someone sees back to back — sign in, then redeem — to stop matching.

    There is no header and no nav here on purpose: this layout is for people
    with no session, and every link in `default.vue` goes somewhere they would
    be bounced straight out of.
  -->
  <div class="auth-backdrop flex min-h-screen flex-col items-center justify-center p-6">
    <div class="rise w-full max-w-sm">
      <div class="mb-8 text-center">
        <!--
          Plain text, not a link. The wordmark in `default.vue` goes home, and
          home is the one place a signed-out visitor cannot go — a link that
          bounces you back to the page you are already on is a dead control
          dressed up as a way out.

          Named here rather than passed in: it is the same library on both
          pages, and the point of the mark is that it does not vary.
        -->
        <p class="text-2xl font-bold tracking-tight text-(--ui-primary)">LIBRARY</p>
        <p class="mt-2 text-sm text-(--ui-text-muted)">Invite-only film library</p>
      </div>

      <slot />
    </div>
  </div>
</template>
