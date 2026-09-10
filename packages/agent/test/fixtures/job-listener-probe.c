/* Build statically in the disposable Linux harness; never a shipped runtime tool. */
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <poll.h>
#include <netinet/tcp.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc != 2) return 10;
  if (!strcmp(argv[1], "nested")) {
    const char *root = getenv("MANIFOLD_JOB_CGROUP_ROOT");
    char path[256];
    if (!root || snprintf(path, sizeof(path), "%s/listener", root) >= (int)sizeof(path)) return 11;
    if (mkdir(path, 0700)) return 12;
    if (snprintf(path, sizeof(path), "%s/listener/cgroup.procs", root) >= (int)sizeof(path)) return 13;
    FILE *group = fopen(path, "w");
    if (!group || fprintf(group, "%ld\n", (long)getpid()) < 0 || fclose(group)) return 14;
  } else if (strcmp(argv[1], "loopback") && strcmp(argv[1], "wildcard") &&
             strcmp(argv[1], "http") && strcmp(argv[1], "deferred")) return 15;
  int fd = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (fd < 0) return 16;
  int reuse = 1;
  if (setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse))) return 21;
  if (!strcmp(argv[1], "deferred")) {
    int enabled = 1, seconds = 60;
    if (setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &enabled, sizeof(enabled))) return 28;
    for (unsigned long wide = 0; wide <= 1; wide++) {
      long result = syscall(SYS_setsockopt, fd, IPPROTO_TCP | (wide << 32),
                            TCP_DEFER_ACCEPT | (wide << 32), &seconds, sizeof(seconds));
      if (result < 0 && errno != EOPNOTSUPP) return 29;
      int actual = -1;
      socklen_t option_size = sizeof(actual);
      if (getsockopt(fd, IPPROTO_TCP, TCP_DEFER_ACCEPT, &actual, &option_size) ||
          (result == 0 ? actual <= 0 : actual != 0)) return 30;
    }
  }
  struct sockaddr_in address = { .sin_family = AF_INET, .sin_port = 0 };
  address.sin_addr.s_addr = htonl(!strcmp(argv[1], "wildcard") ? INADDR_ANY : INADDR_LOOPBACK);
  if (bind(fd, (struct sockaddr *)&address, sizeof(address)) || listen(fd, 8)) return 17;
  socklen_t size = sizeof(address);
  if (getsockname(fd, (struct sockaddr *)&address, &size)) return 18;
  printf("port:%u\n", ntohs(address.sin_port));
  fflush(stdout);
  int peer = -1, accepting = strcmp(argv[1], "http") != 0;
  char bytes[8192];
  size_t used = 0;
  for (;;) {
    struct pollfd fds[] = {
      { .fd = STDIN_FILENO, .events = POLLIN },
      { .fd = accepting ? fd : -1, .events = POLLIN },
      { .fd = peer, .events = POLLIN },
    };
    if (poll(fds, 3, -1) < 0) return 22;
    if (fds[0].revents & (POLLIN | POLLHUP)) {
      char command;
      if (read(STDIN_FILENO, &command, 1) != 1) break;
      if (command == 'a') accepting = 1;
      else if (command == 'c') {
        if (fd < 0 || close(fd)) return 20;
        fd = -1;
        if (peer >= 0) close(peer);
        peer = -1;
        puts("closed");
        fflush(stdout);
        continue;
      } else return 19;
    }
    if (fds[1].revents & POLLIN) {
      if (peer >= 0) return 23;
      peer = accept(fd, NULL, NULL);
      if (peer < 0) return 24;
      used = 0;
    }
    if (fds[2].revents & (POLLIN | POLLHUP)) {
      ssize_t count = read(peer, bytes + used, sizeof(bytes) - used - 1);
      if (count <= 0) { close(peer); peer = -1; continue; }
      used += count;
      bytes[used] = 0;
      if (used == sizeof(bytes) - 1) return 25;
      if (!strstr(bytes, "\r\n0\r\n\r\n")) continue;
      /* Deliberately synthetic credential/body: only respond after both arrive. */
      if (!strstr(bytes, ": Bearer listener-fixture-bearer-000000000000\r\n") ||
          !strstr(bytes, "{\"probe\":true}")) return 26;
      const char *response = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n"
        "Content-Length: 17\r\nConnection: close\r\n\r\n{\"received\":true}";
      if (send(peer, response, strlen(response), MSG_NOSIGNAL) != (ssize_t)strlen(response))
        return 27;
      close(peer);
      peer = -1;
    }
  }
  if (peer >= 0) close(peer);
  if (fd >= 0) close(fd);
  return 0;
}
