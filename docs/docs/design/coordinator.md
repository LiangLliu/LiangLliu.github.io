# Coordinator

## Overview

Why does the Broker provide the important coordination of the entire cluster?

- Broker is actually a compute node which executes the reading and writing operations. Because the Broker needs to know the status information of all Storage nodes, so it performs the coordination tasks;
- Metadata changes are not very frequent and are lightweight.
- Storage nodes status changes are frequent, Broker picks the available shards by those information, so it's not necessary to let Storage managing the statues and then synchronize to the Broker. The advantage is that Storage can focus on storage things.
- Computing ability of a certain database is required across multi IDCs.

What information needs to be processes?

- database DDL operations;
- Storage node management;
- runtime parameter adjustment;
- Storage/Broker state management;

All coordination and scheduling operations are done based on ETCD.
All scheduling messages require a version number to track whether the data on each node is consistent anymore after each node changes in Metadata.


## Master

The master node is responsible for the main Metadata changes. Master is elected from current surviving Broker nodes preemptively. Each Broker node registers the Master Key at the same time, then whoever registers firstly becomes the Master.

At the same time, each Broker will also watch Master Key, If the information on Master Key is lost, the election will be re-elected, so that every Broker node will knows who is Master.

```
- Master Key: /master/node
- Registered Key: /master/node/{broker node}
```

## Task

The task mentioned here mainly refers to the Storage node's received tasks which are sent by Master(Broker). It mainly includes the following two roles:
- Controller;
- Executor;

The ETCD related Keys are as follows: 
```
- Task Key: /task-coordinator/v1/executor/{storage node id}/kinds/{task kind}/names/{task name}
- Task Status Key: /task-coordinator/v1/status/kinds/{task kind}/names/{task name}
```

#### Controller:

The controller runs at the Broker layer:
- Task generation(Task Key): The controller accepts the task submitted by the Master(Broker), then generates a specific Task and send it to the Storage node. The delivery operation is done by ETCD;
- Task status Tracker(Task status Key): A Task status tracker is generated while task is delivered to track specific Task execution status;

#### Executor

Executor runs on the Storage layer:
- Executing the task: Executor will execute the task by watching corresponding Task Key modification;
- Task status update: Executor will update the report of execution result to the corresponding Task Status Key;


## State Machine

All of these operations are done by a variety of different state machines, each of which is described below. Different State Machines will watch the Keys on different ETCDs to perform the corresponding operations.

### Broker Node State Machine 

The State Machine runs on each Broker node, it performs the discovery of the Broker Node.

`Watch Key: /active/nodes`

- When the broker starts, it will register its information to the Watched Key(/active/nodes/{broker node});
- When watched Key changed, every Broker knows which nodes are still alive;


### Storage Cluster Status State Machine

This State Machine runs on each Broker node, it performs the tracking of the survival status of each node in the Storage Cluster.

`Watch Key: /state/storage/cluster`

- The information of Watch Key is written by the Master. The Master will watch the survival of each node in Storage Cluster and write the final information to the corresponding Key(/state/storage/cluster/{cluster name}). For details see [Storage Cluster State Machine](./coordinator.html#storage-cluster-state-machine);
- Status information of each Storage Cluster is available by Broker watched Key change;
- Broker will create a copy channel to Storage according to the situation of the Storage Cluster node and the information of the current Broker WAL. Once the channel is established, the data can be copied. For details see [Replication](./replication.html) ???


### DB Admin State Machine

The State Machine runs on each Master, it will primarily performs the database-related DDL.

`Watch Key: /database/config`

- User can submits the database DDL to any Broker node, then the node does not generate a specific Task for Storage but just write the configuration to "/database/config/{db name}";
- Shard assignment is created by current Storage cluster status by watching the Master Key;
- Task is generated by shard assignment which will be delivered to the corresponding Storage node to perform DDL operation;

Shard Assignment is information about each Shard which contains these details:
```
Name: database name
Nodes: Shard Replica of the located Storage Nodes
Shards: Information about each Shard


Each shard contains the following information:
ShardID: ID of the corresponding Shard:
Replicas: Information about all Replicas to the Shard, which corresponds to the information of the Nodes above. 
```

### Storage Cluster State Machine

This State Machine runs on the Master, it performs the operation of configuration of Storage Cluster.

`Watch Key: /storage/cluster/config`

- User can submits configuration to each Broker node which will simply writes the configuration to "/storage/cluster/config/{cluster name}";
- A Storage Cluster Watch mechanism is established for each cluster to track the survival status of each node;
- The survival or the Storage Node is watched and the status of the entire Storage will be wrote to "/state/storage/cluster/{cluster name}" for [Storage Cluster Status State Machine](./coordinator.html#storage-cluster-status-state-machine)'s usage;

The watch mechanism of each cluster is as follows:
- Establish a relationship with the Storage Cluster ETCD based on the configuration;
- Watch alive key of Storage nodes: `/active/nodes(note that it's different from the broker)`;
- Node information is registered to `/active/nodes/{storage node id}` when Storage node starts;


### Replicator State Machine

This State Machine runs on the Broker, it primarily performs the replication of shard WAL for each database.

`Watch Key: /database/assign`

- Watch Key change: Relationship of each Shard WAL of the database and the target Storage node is generated according to Shard Assignment. For details see [DB Admin State Machine](./coordinator.html#db-admin-state-machine);
- Note that it's just establishing a relationship instead of creating a copy channel;

### Replica Status State Machine

This State Machine runs on the Broker, it primarily performs monitoring the replication status of each Replicas;

`Watch Key: /state/replica`

- WAL replication periodically reports current replication status to the corresponding key ("/state/replica/{storage node id}");
- The status of each copy channel is available by watching `Broker Watch Key`, then the latest Storage node will be chosen when executing the query;
- The status of all replicas under Broker Nodes to Storage nodes peer may include the replication status of multiple different database copies;
 
 
## Fault tolerance
- ETCD is a very central component during the process, as all coordination and scheduling information is done by it;
- Metadata is also stored in ETCD;

So if the ETCD is down, there will be a big impact on the whole system, then how to minimize the impact is critical:

1. Firstly, if ETCD is down,. In the extreme case, the data corruption in the ETCD won't be recovered. Therefore, the relevant node need to perform local backup operations after each Metadata change, and have the ability to restore the new data to new ETCD cluster;
2. ETCD failures should not affect the availability of the entire system;
3. Generally, the Metadata change is low frequency operation, so it's acceptable;
4. If replication of Leader is corrupt, the replication data may be inconsistent;