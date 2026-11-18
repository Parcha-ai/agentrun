---
packages: @parcha/agentrun-serve
kind: fix
---
The console's API playground names an agent's model with the agent editor's Model picker, in both "POST · Create an agent" and "PUT · Edit agent": the models the server offers for the form's harness, the server default first and Custom... last, the free-text box only once Custom... is picked. A model the harness can't run is refused at the field in the editor's words. In both the playground and the editor, what the server said of a model shows at the field only while the form names the harness and model it was said of: a switch of harness hides it, an answer that arrives after the switch included.
