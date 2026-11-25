#!/bin/bash
# From OSWorld (https://github.com/xlang-ai/OSWorld, Apache-2.0, Copyright 2024 XLANG NLP Lab): task
# os/4127319a-8b79-4410-b58a-7a151e15f3d7's setup.sh, from its file cache. Changed for computer-bench: /home/user is the
# run's folder (made fresh here). The four files hold 8, 21, 12 and 13 lines: 54 in all.
d=/tmp/computer-bench-{{nonce}}
rm -rf "$d" && mkdir -p "$d" && cd "$d" || exit 1
mkdir -p project/{models,views,controllers}
echo "<?php
// File: index.php
require_once 'models/User.php';
require_once 'controllers/UserController.php';

// Bootstrap the application
echo 'Application started';
?>" > project/index.php

echo "<?php
// File: models/User.php
class User {
    private \$name;
    private \$email;

    public function __construct(\$name, \$email) {
        \$this->name = \$name;
        \$this->email = \$email;
    }

    // Getter and Setter
    public function getName() {
        return \$this->name;
    }

    public function getEmail() {
        return \$this->email;
    }
}
?>" > project/models/User.php

echo "<?php
// File: controllers/UserController.php
require_once 'models/User.php';

class UserController {
    public function createUser(\$name, \$email) {
        \$user = new User(\$name, \$email);
        // Save the user to a database (simulated)
        echo 'User ' . \$user->getName() . ' created successfully';
    }
}
?>" > project/controllers/UserController.php

echo "<?php
// File: views/home.php
?>
<!DOCTYPE html>
<html>
<head>
    <title>Home Page</title>
</head>
<body>
    <h1>Welcome to our application!</h1>
</body>
</html>
?>" > project/views/home.php
