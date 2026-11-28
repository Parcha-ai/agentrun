# A stand-in for OSWorld's desktop_env/evaluators/metrics/__init__.py (https://github.com/xlang-ai/OSWorld, Apache-2.0,
# Copyright 2024 XLANG NLP Lab): the names the loader's fixtures use, in its import shape. The loader reads it as text.
from .chrome import is_cookie_deleted
from .general import (
    check_include_exclude,
    exact_match,
    match_in_list,
)
from .table import compare_table


def infeasible():
    pass
