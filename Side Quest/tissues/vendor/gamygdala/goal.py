'''
Class Goal
This class is mainly a data structure to store a goal with it's utility and likelihood of being achieved
This is used as basis for interpreting Beliefs
Params:
* name: The name of the goal
* utility: The utility of the goal, or the value the NPC attributes to this goal becoming True; utility = [-1, 1] where a negative value means the NPC does not want this to happen.
* is_maintenance_goal: Defines if the goal is a maintenance goal or not. The default is that the goal is an achievement goal, i.e., a goal that once it's likelihood reaches true (1) or false (-1) stays that way.
'''
class Goal:
    def __init__(self, name, utility, is_maintenance_goal=False):
        self.name = name
        self.utility = utility
        self.likelihood = None # Bug Fix, was 0.5
        self.calculate_likelihood = False
        self.is_maintenance_goal = is_maintenance_goal