#!/usr/bin/env python3
# Timestamp each line on stdin relative to start; write to stdout.
import sys, time
t0 = time.time()
for line in sys.stdin:
    sys.stdout.write("[%8.3f] %s" % (time.time() - t0, line))
    sys.stdout.flush()
