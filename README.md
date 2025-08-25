# CIPPUS Online Judge System

An online judge system based on SYZOJ, useful for ACM/ICPC contests and practices.

### Enhanced features

- To prevent abuse of the platform, only activated accounts can have access to the system.

- Added a real-name and student ID number verification process, where only administrators can view the provided information and decide whether to activate the registered account.

- Only people who manage the problem can access its test data.

- A new Distributed Files section has been added to the competition, facilitating easy upload and download of competition files and solutions.

- A "one-click export of competition results" function has been added, eliminating the hassle of result compilation (only available to competition administrators).

- A rank-freezing feature has been added for ACM-format contests, which maximizes the simulation of real competition scenarios.

### Note

After registering the first admin account on the platform, first you need to open the database program.

```bash
mysql
```

Then execute the following SQL command to activate it:

```sql
UPDATE `syzoj`.`user` SET `pending` = 1 WHERE `id` = 1;
```

Please report any bugs in the issue if you find them.
