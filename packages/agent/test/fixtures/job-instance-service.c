/* Build statically only in the disposable native proof harness. */
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

static int retire(unsigned shutdowns) {
  puts("draining");
  fflush(stdout);
  if (getenv("IGNORE_RETIREMENT")) for (;;) pause();
  /* A killed or prematurely replaced worker cannot commit this final durable state. */
  if (getenv("WAIT_FOR_FLUSH")) {
    while (access("/home/job/service-state/flush-allowed", F_OK)) usleep(1000);
  } else usleep(500000);
  FILE *state = fopen("/home/job/service-state/flushed", "w");
  if (!state || fputs("durable shutdown\n", state) < 0 || fflush(state) ||
      fsync(fileno(state)) || fclose(state)) return 22;
  state = fopen("/home/job/service-state/shutdowns", "w");
  if (!state || fprintf(state, "%u\n", shutdowns + 1) < 0 || fflush(state) ||
      fsync(fileno(state)) || fclose(state)) return 24;
  return 0;
}

int main(void) {
  const char *context = getenv("MANIFOLD_JOB_CONTEXT_FD");
  const char *setting = getenv("FIXED_SERVICE_SETTING");
  if (!context || !setting || strcmp(setting, "reviewed")) return 10;
  int channel = atoi(context);
  char bearer[129];
  FILE *input = fopen("/inputs/serviceBearer", "r");
  if (!input || fscanf(input, "\"%128[^\"]\"", bearer) != 1 || fclose(input)) return 11;
  unsigned starts = 0;
  FILE *state = fopen("/home/job/service-state/starts", "r");
  if (state) { if (fscanf(state, "%u", &starts) != 1 || fclose(state)) return 12; }
  state = fopen("/home/job/service-state/starts", "w");
  if (!state || fprintf(state, "%u\n", ++starts) < 0 || fflush(state) ||
      fsync(fileno(state)) || fclose(state)) return 13;
  /* Capture before readiness: a successor cannot claim a flush completed later. */
  unsigned shutdowns = 0;
  state = fopen("/home/job/service-state/shutdowns", "r");
  if (state) {
    if (fscanf(state, "%u", &shutdowns) != 1 || fclose(state) || shutdowns >= 1000000)
      return 25;
  } else if (errno != ENOENT) return 25;
  int listener = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0);
  struct sockaddr_in address = { .sin_family = AF_INET, .sin_port = 0,
    .sin_addr.s_addr = htonl(INADDR_LOOPBACK) };
  if (listener < 0 || bind(listener, (struct sockaddr *)&address, sizeof(address)) ||
      listen(listener, 8)) return 14;
  socklen_t size = sizeof(address);
  if (getsockname(listener, (struct sockaddr *)&address, &size)) return 15;
  if (dprintf(channel, "{\"type\":\"service_ready\",\"requestId\":\"ready\",\"port\":%u}\n",
              ntohs(address.sin_port)) < 0) return 16;
  FILE *frames = fdopen(dup(channel), "r");
  char frame[8192];
  if (!frames) return 17;
  do { if (!fgets(frame, sizeof(frame), frames)) return retire(shutdowns); }
  while (!strstr(frame, "\"type\":\"service_ready_result\""));
  if (!strstr(frame, "\"ok\":true")) {
    if (strstr(frame, "\"refusal\":\"service_closed\"")) return retire(shutdowns);
    return 19;
  }
  char authority[180];
  snprintf(authority, sizeof(authority), " Bearer %s\r\n", bearer);
  for (;;) {
    struct pollfd watch[2] = {
      { .fd = channel, .events = POLLIN },
      { .fd = listener, .events = POLLIN },
    };
    if (poll(watch, 2, -1) < 0) return 23;
    if (watch[0].revents) {
      char next[8192];
      if (read(channel, next, sizeof(next)) <= 0) return retire(shutdowns);
    }
    if (!(watch[1].revents & POLLIN)) continue;
    int peer = accept(listener, NULL, NULL);
    if (peer < 0) return 20;
    char request[8192];
    size_t used = 0;
    request[0] = 0;
    while (!strstr(request, "\r\n\r\n")) {
      ssize_t count = read(peer, request + used, sizeof(request) - used - 1);
      if (count <= 0 || used + count >= sizeof(request) - 1) break;
      used += count;
      request[used] = 0;
    }
    /* The source accepts only the owner-generated bearer, never a consumer's token. */
    const char *header = strcasestr(request, "\r\nauthorization:");
    if (strncmp(request, "GET /snapshot HTTP/1.1\r\n", 24) || !header ||
        strncmp(strchr(header, ':') + 1, authority, strlen(authority))) { close(peer); continue; }
    char body[128], response[512];
    int bytes = snprintf(body, sizeof(body),
      "{\"starts\":%u,\"shutdowns\":%u,\"setting\":\"%s\"}", starts, shutdowns, setting);
    int length = snprintf(response, sizeof(response),
      "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: %d\r\n"
      "Connection: close\r\n\r\n%s", bytes, body);
    if (send(peer, response, length, MSG_NOSIGNAL) != length) return 21;
    close(peer);
  }
}
