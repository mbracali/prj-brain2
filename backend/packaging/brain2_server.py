"""Entry point of the frozen backend shipped inside the desktop app (``brain2-server``)."""

import multiprocessing

from brain2.__main__ import main

if __name__ == "__main__":
    multiprocessing.freeze_support()
    main()
