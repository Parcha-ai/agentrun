---
packages: @parcha/agentrun-serve
kind: fix
---
A run whose kept computer can't be taken back no longer shows the provider's refusal to the person. Before, a resumed run's timeline could read "The sandbox kept before could not be taken back: the computer … does not match this provider, so attach refuses it and it is left as it is: HostConfig.Mounts: …", with host paths and Docker's settings in it. Now it says why in serve's own words. When the runner that parked the run is gone: "The sandbox wasn't kept: the runner that kept it is gone." When that runner is still there, it says that runner ends it. Otherwise: "The sandbox wasn't kept: it couldn't be taken back." Each goes on to say the run has a new sandbox. The provider's full words go to the runner's log. When the new claim deletes that kept machine, its kept row is marked ended at once, so the run's end removes the row instead of leaving it marked ending until a janitor's pass.
