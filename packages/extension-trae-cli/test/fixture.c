#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <stdlib.h>
#include <dirent.h>

int main(int argc, char **argv) {
  if (argc < 2) return 2;
  int offset = (!strcmp(argv[1], "exec") || !strcmp(argv[1], "models")) ? 1 : 2;
  if (offset == 2 && strcmp(argv[1], "--no-daemon")) return 2;
  if (argc <= offset) return 2;
  if (offset == 2 && !strcmp(argv[offset], "models")) return 2;
  if (!strcmp(argv[offset], "--version")) { puts("traecli 0.210.1\ninstallation: unknown"); return 0; }
  if (argc > offset + 1 && !strcmp(argv[offset + 1], "--help")) {
    puts("--json --output-schema --ephemeral --ignore-user-config --ignore-rules --skip-git-repo-check --disallowed-tool --sandbox --model");
    return 0;
  }
  if (!strcmp(argv[offset], "models")) {
    puts("{\"models\":[{\"id\":\"synthetic\",\"display_name\":\"Synthetic\",\"quota\":99,\"account\":\"PRIVATE\"}]}");
    return 0;
  }
  if (!strcmp(argv[offset], "echo")) {
    int byte;
    while ((byte = getchar()) != EOF) putchar(byte);
    return 0;
  }
  if (!strcmp(argv[offset], "empty")) {
    DIR *dir = opendir(".");
    struct dirent *entry;
    while ((entry = readdir(dir))) if (strcmp(entry->d_name, ".") && strcmp(entry->d_name, "..")) return 3;
    closedir(dir); puts("empty"); return 0;
  }
  const char *model = "";
  for (int i = offset; i + 1 < argc; i++) if (!strcmp(argv[i], "--model")) model = argv[i+1];
  if (!strcmp(model, "telemetry-policy")) {
    const char *names[] = {"TRAECLI_TRACE_ENABLED", "TRAECLI_TRACE_LOG_BODY",
      "TRAECLI_METRICS_ENDPOINT", "TRAECLI_FILE_LOG_ENDPOINT"};
    const char *values[] = {"false", "false", "https://argos-data-collector.bytedance.net/v1/metrics",
      "https://argos-data-collector.bytedance.net/v1/logs"};
    for (int i = 0; i < 4; i++) {
      const char *value = getenv(names[i]);
      if (!value || strcmp(value, values[i])) return 5;
    }
  }
  if (!strcmp(model, "feature-policy")) {
    const char *features[] = {"hooks", "plugins", "multi_agent", "multi_agent_v2", "shell_tool", "shell_snapshot",
      "skill_search", "skill_mcp_dependency_install", "computer_use", "browser_use", "browser_use_external",
      "apps", "code_mode_host", "memories", "prevent_idle_sleep", "unbounded_connection_retries"};
    for (int feature = 0; feature < sizeof(features) / sizeof(features[0]); feature++) {
      int found = 0;
      for (int i = offset; i + 1 < argc; i++)
        if (!strcmp(argv[i], "--disable") && !strcmp(argv[i+1], features[feature])) found = 1;
      if (!found) return 4;
    }
  }
  if (!strcmp(model, "flood")) { while (1) puts("xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"); }
  if (!strcmp(model, "timeout")) { sleep(10); return 0; }
  if (!strcmp(model, "auth")) { puts("{\"type\":\"error\",\"code\":\"unauthorized\",\"message\":\"PRIVATE\"}"); return 1; }
  if (!strcmp(model, "tool")) { puts("{\"type\":\"item.started\",\"item\":{\"type\":\"command_execution\"}}"); fflush(stdout); sleep(10); return 0; }
  puts("{\"type\":\"thread.started\"}");
  puts("{\"type\":\"turn.started\"}");
  puts("{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"{\\\"summary\\\":\\\"Public synthetic answer\\\",\\\"actions\\\":[]}\"}}");
  puts("{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":12,\"output_tokens\":8,\"cached_input_tokens\":2}}");
  return 0;
}
