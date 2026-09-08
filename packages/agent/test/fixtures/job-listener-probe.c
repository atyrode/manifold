/* Build statically in the disposable Linux harness; never a shipped runtime tool. */
#include <arpa/inet.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
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
  } else if (strcmp(argv[1], "loopback") && strcmp(argv[1], "wildcard")) return 15;
  int fd = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (fd < 0) return 16;
  struct sockaddr_in address = { .sin_family = AF_INET, .sin_port = 0 };
  address.sin_addr.s_addr = htonl(!strcmp(argv[1], "wildcard") ? INADDR_ANY : INADDR_LOOPBACK);
  if (bind(fd, (struct sockaddr *)&address, sizeof(address)) || listen(fd, 8)) return 17;
  socklen_t size = sizeof(address);
  if (getsockname(fd, (struct sockaddr *)&address, &size)) return 18;
  printf("port:%u\n", ntohs(address.sin_port));
  fflush(stdout);
  int command = getchar();
  if (command != 'c') return 19;
  if (close(fd)) return 20;
  puts("closed");
  fflush(stdout);
  while (getchar() != EOF) {}
  return 0;
}
