#define main fixture_main
#include "../../extension-trae-cli/test/fixture.c"
#undef main

int main(int argc, char **argv) {
  for (int i = 1; i < argc; i++) {
#ifdef SLOW_VERSION
    if (!strcmp(argv[i], "--version")) sleep(1);
#endif
#ifdef SLOW_HELP
    if (!strcmp(argv[i], "--help")) sleep(1);
#endif
#ifdef SLOW_GENERATION
    if (!strcmp(argv[i], "--model")) sleep(1);
#endif
  }
  return fixture_main(argc, argv);
}
