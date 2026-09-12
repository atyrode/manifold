#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netdb.h>
#include <resolv.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>

static int resolve_fixture(const char *port_text) {
  char *end;
  long port = strtol(port_text, &end, 10);
  if (*end || port < 1 || port > 65535 || res_init() != 0) return 30;
  _res.nscount = 1;
  _res.nsaddr_list[0] = (struct sockaddr_in){
    .sin_family = AF_INET,
    .sin_port = htons((unsigned short)port),
    .sin_addr.s_addr = htonl(INADDR_LOOPBACK),
  };
  _res.retrans = 1;
  _res.retry = 1;
  struct addrinfo hints = {.ai_family = AF_UNSPEC, .ai_socktype = SOCK_STREAM};
  struct addrinfo *addresses;
  int result = getaddrinfo("native-dns.test", NULL, &hints, &addresses);
  if (result != 0) {
    fprintf(stderr, "lookup failed: %s\n", gai_strerror(result));
    return 31;
  }
  for (struct addrinfo *address = addresses; address; address = address->ai_next) {
    char host[NI_MAXHOST];
    if (getnameinfo(address->ai_addr, address->ai_addrlen, host, sizeof(host),
                    NULL, 0, NI_NUMERICHOST) != 0) {
      freeaddrinfo(addresses);
      return 32;
    }
    puts(host);
  }
  freeaddrinfo(addresses);
  return 0;
}

/* Disposable test artifact, not an agent runtime dependency. Build statically for
 * the target architecture and supply MANIFOLD_TEST_SYSCALL_PROBE to the Linux and owner tests. */
int main(int argc, char **argv) {
  if (argc == 3 && strcmp(argv[1], "dns") == 0) return resolve_fixture(argv[2]);
  if (argc == 2 && strcmp(argv[1], "worker") == 0) {
    fputs("private-once", stdout);
    fputs("diagnostic", stderr);
    return 0;
  }
  int sockets[2];
  if (socketpair(AF_UNIX, SOCK_STREAM, 0, sockets) != 0) return 10;
  int fd = open("/tmp/descriptor", O_CREAT | O_RDWR, 0600);
  if (fd < 0) return 11;
  char byte = 'x';
  struct iovec vector = {.iov_base = &byte, .iov_len = 1};
  union {
    struct cmsghdr alignment;
    char bytes[CMSG_SPACE(sizeof(int))];
  } control = {0};
  struct msghdr message = {
    .msg_iov = &vector,
    .msg_iovlen = 1,
    .msg_control = control.bytes,
    .msg_controllen = sizeof(control.bytes),
  };
  struct cmsghdr *header = CMSG_FIRSTHDR(&message);
  header->cmsg_level = SOL_SOCKET;
  header->cmsg_type = SCM_RIGHTS;
  header->cmsg_len = CMSG_LEN(sizeof(int));
  memcpy(CMSG_DATA(header), &fd, sizeof(fd));
  errno = 0;
  if (syscall(SYS_sendmsg, sockets[0], &message, MSG_NOSIGNAL) != -1 || errno != EPERM)
    return 12;
  struct mmsghdr batch = {.msg_hdr = message};
  errno = 0;
  if (syscall(SYS_sendmmsg, sockets[0], &batch, 1, MSG_NOSIGNAL) != -1 || errno != EPERM)
    return 13;
  errno = 0;
  if (recvmsg(sockets[1], &message, MSG_DONTWAIT) != -1 || errno != EAGAIN) return 14;
  errno = 0;
  if (syscall(SYS_io_uring_setup, 1, NULL) != -1 || errno != EPERM) return 15;
  errno = 0;
  if (syscall(SYS_io_uring_enter, -1, 0, 0, 0, NULL, 0) != -1 || errno != EPERM) return 16;
  errno = 0;
  if (syscall(SYS_io_uring_register, -1, 0, NULL, 0) != -1 || errno != EPERM) return 17;
#if defined(__x86_64__)
  errno = 0;
  if (syscall(0x40000000L | SYS_sendmsg, sockets[0], &message, MSG_NOSIGNAL) != -1 ||
      errno != EPERM) return 18;
  pid_t child = fork();
  if (child < 0) return 19;
  if (child == 0) {
    long result;
    __asm__ volatile("int $0x80" : "=a"(result) : "0"(20) : "memory");
    _exit(20);
  }
  int status;
  if (waitpid(child, &status, 0) != child || !WIFSIGNALED(status) || WTERMSIG(status) != SIGSYS)
    return 21;
#endif
  if (write(sockets[0], "b", 1) != 1 || read(sockets[1], &byte, 1) != 1 || byte != 'b')
    return 22;
  if (write(3, "context-byte", 12) != 12 || read(3, &byte, 1) != 1 || byte != 'a') return 23;
  close(fd);
  close(sockets[0]);
  close(sockets[1]);
  puts("fd-export-denied;byte-context-ok");
  return 0;
}
