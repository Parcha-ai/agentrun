---
packages: repo
kind: ci
---
The source check gives the downloaded source tree's install and whole build 600 seconds each, where every command had 180: a slow CI runner ran the build past 180 seconds once. Every other command keeps 180.
