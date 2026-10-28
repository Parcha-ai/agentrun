// A shared corpus of tool and output schemas, for the schema-parity table: each harness adapter runs the same set and
// says, per schema, whether it reaches its model whole. Keyed by `schemaHash`. Written for AgentRun.
//
// Its sources: tool input schemas exactly as pydantic emits them (with an input that fits, dumped by pydantic), the
// submit tool an agent node gets for each of the issue-triage example's schemas (the DSL's submitParameters of the
// schema resolved against its workflow, as the runner builds it), and edge cases (everything one bridge carries, and one schema per construct it
// cannot). Regenerate the pydantic entries with pydantic itself, never by hand.
import { schemaHash } from "./schema-hash.js";

/** One schema of the corpus: its hash (`schemaHash`), where it comes from, the schema, and an input that fits it. */
export interface SchemaCorpusEntry {
  hash: string;
  source: string;
  schema: Record<string, unknown>;
  example?: unknown;
}

const ENTRIES: Omit<SchemaCorpusEntry, "hash">[] = [
 {
  "source": "pydantic 2.13.5 model_json_schema: SearchInput",
  "schema": {
   "$defs": {
    "Address": {
     "properties": {
      "street": {
       "description": "Street and number.",
       "title": "Street",
       "type": "string"
      },
      "country": {
       "maxLength": 2,
       "minLength": 2,
       "pattern": "^[A-Z]{2}$",
       "title": "Country",
       "type": "string"
      },
      "postcode": {
       "anyOf": [
        {
         "type": "string"
        },
        {
         "type": "null"
        }
       ],
       "default": null,
       "title": "Postcode"
      }
     },
     "required": [
      "street",
      "country"
     ],
     "title": "Address",
     "type": "object"
    },
    "Depth": {
     "enum": [
      "quick",
      "deep"
     ],
     "title": "Depth",
     "type": "string"
    },
    "Person": {
     "properties": {
      "name": {
       "maxLength": 200,
       "minLength": 1,
       "title": "Full name",
       "type": "string"
      },
      "born": {
       "anyOf": [
        {
         "format": "date",
         "type": "string"
        },
        {
         "type": "null"
        }
       ],
       "default": null,
       "title": "Born"
      },
      "address": {
       "anyOf": [
        {
         "$ref": "#/$defs/Address"
        },
        {
         "type": "null"
        }
       ],
       "default": null
      },
      "aliases": {
       "items": {
        "type": "string"
       },
       "maxItems": 10,
       "title": "Aliases",
       "type": "array"
      }
     },
     "required": [
      "name"
     ],
     "title": "Person",
     "type": "object"
    }
   },
   "description": "Search the web for a subject.",
   "properties": {
    "query": {
     "description": "What to look for.",
     "examples": [
      "acme corp"
     ],
     "minLength": 1,
     "title": "Query",
     "type": "string"
    },
    "depth": {
     "$ref": "#/$defs/Depth",
     "default": "quick"
    },
    "limit": {
     "default": 10,
     "maximum": 50,
     "minimum": 1,
     "title": "Limit",
     "type": "integer"
    },
    "score_floor": {
     "default": 0.0,
     "maximum": 1,
     "minimum": 0,
     "title": "Score Floor",
     "type": "number"
    },
    "site": {
     "anyOf": [
      {
       "format": "uri",
       "maxLength": 2083,
       "minLength": 1,
       "type": "string"
      },
      {
       "type": "null"
      }
     ],
     "default": null,
     "title": "Site"
    },
    "kind": {
     "default": "web",
     "enum": [
      "web",
      "news"
     ],
     "title": "Kind",
     "type": "string"
    },
    "subject": {
     "$ref": "#/$defs/Person"
    },
    "others": {
     "default": [],
     "items": {
      "$ref": "#/$defs/Person"
     },
     "title": "Others",
     "type": "array"
    },
    "tags": {
     "additionalProperties": {
      "type": "string"
     },
     "default": {},
     "title": "Tags",
     "type": "object"
    }
   },
   "required": [
    "query",
    "subject"
   ],
   "title": "SearchInput",
   "type": "object"
  },
  "example": {
   "query": "acme",
   "depth": "deep",
   "limit": 5,
   "score_floor": 0.0,
   "site": null,
   "kind": "web",
   "subject": {
    "name": "Ada",
    "born": "1990-01-02",
    "address": {
     "street": "1 Main",
     "country": "US",
     "postcode": null
    },
    "aliases": []
   },
   "others": [
    {
     "name": "Bo",
     "born": null,
     "address": null,
     "aliases": []
    }
   ],
   "tags": {
    "k": "v"
   }
  }
 },
 {
  "source": "pydantic 2.13.5 model_json_schema: FetchInput",
  "schema": {
   "properties": {
    "url": {
     "format": "uri",
     "maxLength": 2083,
     "minLength": 1,
     "title": "Url",
     "type": "string"
    },
    "timeout_s": {
     "anyOf": [
      {
       "exclusiveMinimum": 0,
       "type": "integer"
      },
      {
       "type": "null"
      }
     ],
     "default": null,
     "title": "Timeout S"
    }
   },
   "required": [
    "url"
   ],
   "title": "FetchInput",
   "type": "object"
  },
  "example": {
   "url": "https://example.com/a",
   "timeout_s": null
  }
 },
 {
  "source": "examples/issue-triage/workflow.json: the submit tool of an agent node whose output is Input (submitParameters of the resolved schema)",
  "schema": {
   "type": "object",
   "properties": {
    "value": {
     "type": "object",
     "properties": {
      "repo": {
       "type": "string",
       "minLength": 1,
       "description": "owner/name of the public repository"
      },
      "numbers": {
       "type": "array",
       "minItems": 1,
       "items": {
        "type": "integer",
        "minimum": 1
       },
       "description": "issue numbers to triage"
      },
      "sha": {
       "type": "string",
       "pattern": "^[0-9a-f]{40}$",
       "description": "the commit the code is read at: the repository's default branch when the run was picked, fixed for the whole run"
      },
      "label_map": {
       "type": "object",
       "description": "the maintainers' type labels mapped onto the four: bug, feature, docs, question",
       "additionalProperties": {
        "type": "string",
        "enum": [
         "bug",
         "feature",
         "docs",
         "question"
        ]
       }
      }
     },
     "required": [
      "repo",
      "numbers",
      "sha",
      "label_map"
     ],
     "additionalProperties": false
    }
   },
   "required": [
    "value"
   ],
   "additionalProperties": false
  }
 },
 {
  "source": "examples/issue-triage/workflow.json: the submit tool of an agent node whose output is IssueRecord (submitParameters of the resolved schema)",
  "schema": {
   "type": "object",
   "properties": {
    "value": {
     "type": "object",
     "properties": {
      "number": {
       "type": "integer"
      },
      "title": {
       "type": "string"
      },
      "body": {
       "type": "string"
      },
      "url": {
       "type": "string"
      }
     },
     "required": [
      "number",
      "title",
      "body",
      "url"
     ]
    }
   },
   "required": [
    "value"
   ],
   "additionalProperties": false
  }
 },
 {
  "source": "examples/issue-triage/workflow.json: the submit tool of an agent node whose output is LinkedPrs (submitParameters of the resolved schema)",
  "schema": {
   "type": "object",
   "properties": {
    "value": {
     "type": "object",
     "properties": {
      "prs": {
       "type": "array",
       "items": {
        "type": "object",
        "properties": {
         "number": {
          "type": "integer"
         },
         "title": {
          "type": "string"
         },
         "state": {
          "type": "string"
         },
         "paths": {
          "type": "array",
          "items": {
           "type": "string"
          }
         }
        },
        "required": [
         "number",
         "title",
         "state",
         "paths"
        ]
       }
      }
     },
     "required": [
      "prs"
     ]
    }
   },
   "required": [
    "value"
   ],
   "additionalProperties": false
  }
 },
 {
  "source": "examples/issue-triage/workflow.json: the submit tool of an agent node whose output is Research (submitParameters of the resolved schema)",
  "schema": {
   "type": "object",
   "properties": {
    "value": {
     "type": "object",
     "properties": {
      "summary": {
       "type": "string",
       "description": "What the issue asks, in two or three sentences, from what the tools returned."
      },
      "reproduces": {
       "type": "string",
       "enum": [
        "yes",
        "no",
        "not stated"
       ],
       "description": "Whether the issue gives a way to reproduce what it reports."
      },
      "code_paths": {
       "type": "array",
       "items": {
        "type": "string"
       },
       "description": "Repository paths the issue or its pull requests name, that you read."
      },
      "evidence": {
       "type": "array",
       "minItems": 1,
       "items": {
        "type": "object",
        "properties": {
         "source": {
          "type": "string",
          "description": "issue, pr <number>, or a file path you read"
         },
         "quote": {
          "type": "string",
          "description": "A short quotation, at most 200 characters, copied from that source.",
          "maxLength": 200
         }
        },
        "required": [
         "source",
         "quote"
        ],
        "additionalProperties": false
       }
      }
     },
     "required": [
      "summary",
      "reproduces",
      "code_paths",
      "evidence"
     ],
     "additionalProperties": false
    }
   },
   "required": [
    "value"
   ],
   "additionalProperties": false
  }
 },
 {
  "source": "examples/issue-triage/workflow.json: the submit tool of an agent node whose output is Row (submitParameters of the resolved schema)",
  "schema": {
   "type": "object",
   "properties": {
    "value": {
     "type": "object",
     "properties": {
      "number": {
       "type": "integer"
      },
      "title": {
       "type": "string"
      },
      "url": {
       "type": "string"
      },
      "label": {
       "type": "string",
       "enum": [
        "bug",
        "feature",
        "docs",
        "question"
       ]
      },
      "label_confidence": {
       "type": "number",
       "minimum": 0,
       "maximum": 1
      },
      "good_first_issue": {
       "type": "boolean"
      },
      "good_first_confidence": {
       "type": "number",
       "minimum": 0,
       "maximum": 1
      },
      "evidence": {
       "type": "array",
       "items": {
        "type": "object",
        "properties": {
         "source": {
          "type": "string"
         },
         "quote": {
          "type": "string"
         }
        },
        "required": [
         "source",
         "quote"
        ]
       }
      },
      "maintainer_label": {
       "type": [
        "string",
        "null"
       ],
       "enum": [
        null,
        "bug",
        "feature",
        "docs",
        "question"
       ]
      },
      "agrees": {
       "type": [
        "boolean",
        "null"
       ]
      },
      "actionable": {
       "type": "boolean"
      },
      "actionable_confidence": {
       "type": "number",
       "minimum": 0,
       "maximum": 1
      }
     },
     "required": [
      "number",
      "title",
      "url",
      "label",
      "label_confidence",
      "good_first_issue",
      "good_first_confidence",
      "evidence",
      "maintainer_label",
      "agrees",
      "actionable",
      "actionable_confidence"
     ],
     "additionalProperties": false
    }
   },
   "required": [
    "value"
   ],
   "additionalProperties": false
  }
 },
 {
  "source": "examples/issue-triage/workflow.json: the submit tool of an agent node whose output is Result (submitParameters of the resolved schema)",
  "schema": {
   "type": "object",
   "properties": {
    "value": {
     "type": "object",
     "properties": {
      "repo": {
       "type": "string"
      },
      "rows": {
       "type": "array",
       "items": {
        "$ref": "#/properties/value/definitions/Row"
       }
      },
      "agreement": {
       "type": "object",
       "properties": {
        "agreed": {
         "type": "integer"
        },
        "compared": {
         "type": "integer"
        },
        "total": {
         "type": "integer"
        },
        "summary": {
         "type": "string"
        },
        "note": {
         "type": "string"
        }
       },
       "required": [
        "agreed",
        "compared",
        "total",
        "summary",
        "note"
       ],
       "additionalProperties": false
      }
     },
     "required": [
      "repo",
      "rows",
      "agreement"
     ],
     "additionalProperties": false,
     "definitions": {
      "Row": {
       "type": "object",
       "properties": {
        "number": {
         "type": "integer"
        },
        "title": {
         "type": "string"
        },
        "url": {
         "type": "string"
        },
        "label": {
         "type": "string",
         "enum": [
          "bug",
          "feature",
          "docs",
          "question"
         ]
        },
        "label_confidence": {
         "type": "number",
         "minimum": 0,
         "maximum": 1
        },
        "good_first_issue": {
         "type": "boolean"
        },
        "good_first_confidence": {
         "type": "number",
         "minimum": 0,
         "maximum": 1
        },
        "evidence": {
         "type": "array",
         "items": {
          "type": "object",
          "properties": {
           "source": {
            "type": "string"
           },
           "quote": {
            "type": "string"
           }
          },
          "required": [
           "source",
           "quote"
          ]
         }
        },
        "maintainer_label": {
         "type": [
          "string",
          "null"
         ],
         "enum": [
          null,
          "bug",
          "feature",
          "docs",
          "question"
         ]
        },
        "agrees": {
         "type": [
          "boolean",
          "null"
         ]
        },
        "actionable": {
         "type": "boolean"
        },
        "actionable_confidence": {
         "type": "number",
         "minimum": 0,
         "maximum": 1
        }
       },
       "required": [
        "number",
        "title",
        "url",
        "label",
        "label_confidence",
        "good_first_issue",
        "good_first_confidence",
        "evidence",
        "maintainer_label",
        "agrees",
        "actionable",
        "actionable_confidence"
       ],
       "additionalProperties": false
      }
     }
    }
   },
   "required": [
    "value"
   ],
   "additionalProperties": false
  }
 },
 {
  "source": "examples/issue-triage/workflow.json: the submit tool of an agent node whose output is MaintainerLabels (submitParameters of the resolved schema)",
  "schema": {
   "type": "object",
   "properties": {
    "value": {
     "type": "object",
     "properties": {
      "labels": {
       "type": "array",
       "items": {
        "type": "string"
       }
      }
     },
     "required": [
      "labels"
     ]
    }
   },
   "required": [
    "value"
   ],
   "additionalProperties": false
  }
 },
 {
  "source": "examples/issue-triage/workflow.json: the submit tool of an agent node whose output is CodeFetched (submitParameters of the resolved schema)",
  "schema": {
   "type": "object",
   "properties": {
    "value": {
     "type": "object",
     "properties": {
      "paths": {
       "type": "array",
       "items": {
        "type": "string"
       },
       "description": "Repository paths now readable under repo/ in the workspace."
      }
     },
     "required": [
      "paths"
     ]
    }
   },
   "required": [
    "value"
   ],
   "additionalProperties": false
  }
 },
 {
  "source": "examples/issue-triage/workflow.json: the submit tool of an agent node whose output is Judgment (submitParameters of the resolved schema)",
  "schema": {
   "type": "object",
   "properties": {
    "value": {
     "type": "object",
     "properties": {
      "label": {
       "type": "string",
       "enum": [
        "bug",
        "feature",
        "docs",
        "question"
       ],
       "description": "Which one type fits this issue best, going by what the issue asks for and the evidence read for it, not by who wrote it or how it is worded?",
       "criteria": {
        "bug": "The issue reports behaviour that contradicts the repository's own documentation or an earlier release, with a way to see it fail.",
        "feature": "The issue asks for behaviour the project does not have, or a change to an API on purpose; nothing is broken today.",
        "docs": "The issue is about wrong, missing or unclear documentation, a README or a guide; the code behaves as designed.",
        "question": "The reporter asks how to use the project, or why it works as it does; no change is asked for."
       }
      },
      "good_first_issue": {
       "type": "boolean",
       "description": "Is this a good first issue: could a newcomer to the project take it and finish it without a maintainer's design decision?",
       "criteria": {
        "true": "The change is small and local (one file or one function), the issue names where it is, the expected result is stated or checkable by a test, and a newcomer can do it without knowing the project's design.",
        "false": "The change spans several modules, needs a design decision from a maintainer, depends on an unreleased change or an unclear ask, or needs knowledge of the project's internals."
       }
      },
      "actionable": {
       "type": "boolean",
       "description": "Can a maintainer act on this report as written: does it give enough to start work without asking the reporter anything first?",
       "criteria": {
        "true": "The report states what is wrong or what is wanted and gives enough to start: a version or setup, a way to reproduce, or a clear ask.",
        "false": "The report is missing something a maintainer must ask for before starting: a version or setup, a way to reproduce, or what is wanted."
       }
      }
     },
     "required": [
      "label",
      "good_first_issue",
      "actionable"
     ],
     "additionalProperties": false
    }
   },
   "required": [
    "value"
   ],
   "additionalProperties": false
  }
 },
 {
  "source": "edge: everything the Claude bridge carries",
  "schema": {
   "type": "object",
   "title": "Search",
   "description": "Search the web.",
   "properties": {
    "query": {
     "type": "string",
     "description": "What to look for.",
     "minLength": 1,
     "maxLength": 200
    },
    "limit": {
     "type": "integer",
     "minimum": 1,
     "maximum": 50
    },
    "score": {
     "type": "number",
     "exclusiveMinimum": 0,
     "exclusiveMaximum": 1,
     "multipleOf": 0.25
    },
    "code": {
     "type": "string",
     "pattern": "^[A-Z]{2}$"
    },
    "email": {
     "type": "string",
     "format": "email"
    },
    "page": {
     "type": "string",
     "format": "uri"
    },
    "at": {
     "type": "string",
     "format": "date-time"
    },
    "day": {
     "type": "string",
     "format": "date"
    },
    "depth": {
     "enum": [
      "quick",
      "deep"
     ]
    },
    "kind": {
     "const": "web"
    },
    "since": {
     "type": [
      "string",
      "null"
     ]
    },
    "region": {
     "type": "string",
     "nullable": true
    },
    "sites": {
     "type": "array",
     "items": {
      "type": "string"
     },
     "minItems": 1,
     "maxItems": 3
    },
    "filter": {
     "anyOf": [
      {
       "type": "string"
      },
      {
       "type": "object",
       "properties": {
        "domain": {
         "type": "string"
        }
       },
       "required": [
        "domain"
       ],
       "additionalProperties": false
      }
     ]
    },
    "extra": {
     "type": "object",
     "additionalProperties": {
      "type": "number"
     }
    },
    "anything": {}
   },
   "required": [
    "query",
    "depth"
   ],
   "additionalProperties": false
  },
  "example": {
   "query": "acme",
   "limit": 5,
   "score": 0.5,
   "code": "US",
   "email": "a@b.example",
   "page": "https://b.example/x",
   "at": "2026-10-28T06:00:00Z",
   "day": "2026-10-28",
   "depth": "deep",
   "kind": "web",
   "since": null,
   "region": null,
   "sites": [
    "a.example"
   ],
   "filter": {
    "domain": "b.example"
   },
   "extra": {
    "x": 1
   },
   "anything": [
    1,
    "two"
   ]
  }
 },
 {
  "source": "edge: format hostname",
  "schema": {
   "type": "object",
   "properties": {
    "p": {
     "type": "string",
     "format": "hostname"
    }
   }
  }
 },
 {
  "source": "edge: format time",
  "schema": {
   "type": "object",
   "properties": {
    "p": {
     "type": "string",
     "format": "time"
    }
   }
  }
 },
 {
  "source": "edge: format with no type",
  "schema": {
   "type": "object",
   "properties": {
    "p": {
     "format": "email"
    }
   }
  }
 },
 {
  "source": "edge: minLength on a number",
  "schema": {
   "type": "object",
   "properties": {
    "p": {
     "type": "number",
     "minLength": 1
    }
   }
  }
 },
 {
  "source": "edge: uniqueItems",
  "schema": {
   "type": "object",
   "properties": {
    "p": {
     "type": "array",
     "items": {
      "type": "string"
     },
     "uniqueItems": true
    }
   }
  }
 },
 {
  "source": "edge: remote $ref",
  "schema": {
   "type": "object",
   "properties": {
    "p": {
     "$ref": "https://example.com/schema.json"
    }
   }
  }
 },
 {
  "source": "edge: recursive $ref",
  "schema": {
   "$defs": {
    "Node": {
     "type": "object",
     "properties": {
      "child": {
       "$ref": "#/$defs/Node"
      }
     }
    }
   },
   "type": "object",
   "properties": {
    "p": {
     "$ref": "#/$defs/Node"
    }
   }
  }
 },
 {
  "source": "edge: allOf",
  "schema": {
   "type": "object",
   "properties": {
    "p": {
     "allOf": [
      {
       "type": "string"
      },
      {
       "minLength": 1
      }
     ]
    }
   }
  }
 },
 {
  "source": "edge: not",
  "schema": {
   "type": "object",
   "properties": {
    "p": {
     "not": {
      "type": "string"
     }
    }
   }
  }
 },
 {
  "source": "edge: oneOf between real alternatives",
  "schema": {
   "type": "object",
   "properties": {
    "p": {
     "oneOf": [
      {
       "type": "string"
      },
      {
       "type": "number"
      }
     ]
    }
   }
  }
 },
 {
  "source": "edge: oneOf of one schema or null",
  "schema": {
   "type": "object",
   "properties": {
    "p": {
     "oneOf": [
      {
       "type": "string"
      },
      {
       "type": "null"
      }
     ]
    }
   }
  }
 },
 {
  "source": "edge: tuple items",
  "schema": {
   "type": "object",
   "properties": {
    "p": {
     "type": "array",
     "items": [
      {
       "type": "string"
      },
      {
       "type": "number"
      }
     ]
    }
   }
  }
 },
 {
  "source": "edge: prefixItems",
  "schema": {
   "type": "object",
   "properties": {
    "p": {
     "type": "array",
     "prefixItems": [
      {
       "type": "string"
      }
     ]
    }
   }
  }
 },
 {
  "source": "edge: two non-null types",
  "schema": {
   "type": "object",
   "properties": {
    "p": {
     "type": [
      "string",
      "number"
     ]
    }
   }
  }
 },
 {
  "source": "edge: an object in enum",
  "schema": {
   "type": "object",
   "properties": {
    "p": {
     "enum": [
      {
       "a": 1
      }
     ]
    }
   }
  }
 },
 {
  "source": "edge: patternProperties",
  "schema": {
   "type": "object",
   "properties": {
    "p": {
     "type": "object",
     "patternProperties": {
      "^x": {
       "type": "string"
      }
     }
    }
   }
  }
 },
 {
  "source": "edge: if/then",
  "schema": {
   "type": "object",
   "properties": {
    "p": {
     "type": "object",
     "if": {
      "properties": {
       "a": {
        "const": 1
       }
      }
     },
     "then": {
      "required": [
       "b"
      ]
     }
    }
   }
  }
 }
];

/** The corpus, each entry with its hash. */
export const SCHEMA_CORPUS: readonly SchemaCorpusEntry[] = Object.freeze(ENTRIES.map((entry) => Object.freeze({ hash: schemaHash(entry.schema), ...entry })));
