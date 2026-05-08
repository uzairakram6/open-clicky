#include <stdio.h>
#include <X11/Xlib.h>
#include <unistd.h>
#include <signal.h>

static volatile int running = 1;

static void handle_signal(int sig) {
  (void)sig;
  running = 0;
}

int main(void) {
  signal(SIGINT, handle_signal);
  signal(SIGTERM, handle_signal);

  Display *dpy = XOpenDisplay(NULL);
  if (!dpy) {
    fprintf(stderr, "cursor_query: XOpenDisplay failed\n");
    return 1;
  }

  Window root = DefaultRootWindow(dpy);
  Window root_ret, child_ret;
  int root_x, root_y, win_x, win_y;
  unsigned int mask;

  while (running) {
    if (XQueryPointer(dpy, root, &root_ret, &child_ret,
                      &root_x, &root_y, &win_x, &win_y, &mask) == True) {
      printf("%d %d\n", root_x, root_y);
      fflush(stdout);
    }
    usleep(8000);
  }

  XCloseDisplay(dpy);
  return 0;
}
